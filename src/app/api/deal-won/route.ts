// src/app/api/deal-won/route.ts
import { NextResponse, NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // never cache webhook responses

type Json = Record<string, unknown>;

const HUBSPOT_BASE = 'https://api.hubapi.com';
const FRONTEGG_BASE = process.env.FRONTEGG_BASE_URL || 'https://api.frontegg.com';
const FRONTEGG_IDENTITY_BASE =
  process.env.FRONTEGG_IDENTITY_BASE || `${FRONTEGG_BASE}/identity`;

/** ----- Utilities ----- */

function unauthorized(msg = 'unauthorized') {
  return NextResponse.json({ error: msg }, { status: 401 });
}
function badRequest(msg = 'bad_request') {
  return NextResponse.json({ error: msg }, { status: 400 });
}
function unprocessable(msg = 'unprocessable') {
  return NextResponse.json({ error: msg }, { status: 422 });
}
function ok(body: Json) {
  return NextResponse.json(body, { status: 200 });
}
function fail(detail: unknown) {
  console.error('[deal-won] error:', detail);
  return NextResponse.json({ error: 'internal_error', detail }, { status: 500 });
}

async function hs<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const hubspotToken = process.env.HUBSPOT_TOKEN;
  if (!hubspotToken) {
    throw new Error('HUBSPOT_TOKEN environment variable not set');
  }

  const r = await fetch(`${HUBSPOT_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${hubspotToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    // No keepalive needed; Vercel Node runtime is fine with default
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`HubSpot ${path} -> ${r.status} ${txt}`);
  }
  return r.json() as Promise<T>;
}

async function getFronteggMgmtToken(): Promise<string> {
  const clientId = process.env.FRONTEGG_CLIENT_ID;
  const apiKey = process.env.FRONTEGG_API_KEY;
  
  if (!clientId || !apiKey) {
    throw new Error('FRONTEGG_CLIENT_ID or FRONTEGG_API_KEY environment variables not set');
  }

  const r = await fetch(`${FRONTEGG_BASE}/auth/vendor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      secret: apiKey,
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`/auth/vendor -> ${r.status} ${txt}`);
  }
  const data = (await r.json()) as { token: string };
  if (!data.token) {
    throw new Error('No token received from Frontegg');
  }
  return data.token;
}

async function feCreateTenant(mgmtToken: string, tenantId: string, name: string) {
  const r = await fetch(`${FRONTEGG_BASE}/tenants/resources/tenants/v1`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mgmtToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tenantId, name }),
  });

  if (!r.ok) {
    const txt = await r.text();
    // Frontegg may 409 if tenant exists; treat as idempotent
    if (r.status !== 409) throw new Error(`Create tenant -> ${r.status} ${txt}`);
  }
}

async function feInviteAdmin(mgmtToken: string, tenantId: string, email: string) {
  const users: Array<{ email: string; roleIds?: string[] }> = [{ email }];
  if (process.env.ADMIN_ROLE_ID) {
    users[0].roleIds = [process.env.ADMIN_ROLE_ID];
  }

  const r = await fetch(`${FRONTEGG_IDENTITY_BASE}/resources/users/bulk/v1/invite`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mgmtToken}`,
      'frontegg-tenant-id': tenantId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ users }),
  });

  if (!r.ok) {
    const txt = await r.text();
    // Some “already invited/exists” states may surface; allow 409 to pass
    if (r.status !== 409) throw new Error(`Invite admin -> ${r.status} ${txt}`);
  }
}

async function getPrimaryAssociationTypeId(
  pair: 'deal/company' | 'deal/contact',
): Promise<number | undefined> {
  type LabelsResp = { results?: Array<{ label: string; typeId: number; category: string }> };
  const labels = await hs<LabelsResp>(`/crm/v4/associations/${pair}/labels`);
  return labels.results?.find(
    (l) => l.category === 'HUBSPOT_DEFINED' && /Primary/i.test(l.label),
  )?.typeId;
}

async function getPrimaryAssociatedCompanyId(dealId: string): Promise<string | undefined> {
  const primaryTypeId = await getPrimaryAssociationTypeId('deal/company');
  const assoc = await hs<{
    results?: Array<{ toObjectId: number; types?: Array<{ associationTypeId: number }> }>;
  }>(`/crm/v4/objects/deals/${dealId}/associations/companies`);

  // Prefer Primary; otherwise first
  for (const r of assoc.results || []) {
    const typeIds = (r.types || []).map((t) => t.associationTypeId);
    if (primaryTypeId && typeIds.includes(primaryTypeId)) return String(r.toObjectId);
  }
  return assoc.results?.[0]?.toObjectId ? String(assoc.results[0].toObjectId) : undefined;
}

async function getCompany(dealCompanyId: string): Promise<{ name: string; domain: string }> {
  const c = await hs<{ properties?: { name?: string; domain?: string } }>(
    `/crm/v3/objects/companies/${dealCompanyId}?properties=name,domain`,
  );
  return {
    name: c.properties?.name || 'New Account',
    domain: c.properties?.domain || '',
  };
}

async function getPrimaryAssociatedContactId(dealId: string): Promise<string | undefined> {
  const primaryTypeId = await getPrimaryAssociationTypeId('deal/contact');
  const assoc = await hs<{
    results?: Array<{ toObjectId: number; types?: Array<{ associationTypeId: number }> }>;
  }>(`/crm/v4/objects/deals/${dealId}/associations/contacts`);

  for (const r of assoc.results || []) {
    const typeIds = (r.types || []).map((t) => t.associationTypeId);
    if (primaryTypeId && typeIds.includes(primaryTypeId)) return String(r.toObjectId);
  }
  return assoc.results?.[0]?.toObjectId ? String(assoc.results[0].toObjectId) : undefined;
}

async function getContactEmail(contactId: string): Promise<string | undefined> {
  const c = await hs<{ properties?: { email?: string } }>(
    `/crm/v3/objects/contacts/${contactId}?properties=email`,
  );
  return c.properties?.email || undefined;
}

/** ----- Route handler ----- */

export async function POST(req: NextRequest) {
  try {
    // 1) Basic auth check (HubSpot Workflow -> Send a webhook)
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) return unauthorized('WEBHOOK_SECRET not set');
    const auth = req.headers.get('authorization') || '';
    if (auth !== `Bearer ${secret}`) return unauthorized();

    // 2) Parse payload (HubSpot Workflow can send custom JSON)
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch (parseError) {
      return badRequest('Invalid JSON payload');
    }
    
    const dealId = String(body.dealId || body.objectId || '');
    if (!dealId) return badRequest('dealId missing');

    // 3) HubSpot: find Primary company & contact for the deal
    const companyId = await getPrimaryAssociatedCompanyId(dealId);
    if (!companyId) return unprocessable('No associated company');

    const { name: companyName, domain } = await getCompany(companyId);

    const contactId = await getPrimaryAssociatedContactId(dealId);
    if (!contactId) return unprocessable('No associated contact');

    const pocEmail = await getContactEmail(contactId);
    if (!pocEmail) return unprocessable('POC contact has no email');

    // 4) Frontegg: env token
    const mgmtToken = await getFronteggMgmtToken();

    // 5) Idempotent tenant id (stable key using HubSpot company id)
    const tenantId = `hsco-${companyId}`;
    await feCreateTenant(mgmtToken, tenantId, companyName);

    // 6) Invite admin
    await feInviteAdmin(mgmtToken, tenantId, pocEmail);

    return ok({
      ok: true,
      tenantId,
      invited: pocEmail,
      companyName,
      companyDomain: domain,
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return fail(errorMessage);
  }
}
