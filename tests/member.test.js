process.env.DB_STORAGE = ':memory:';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { sequelize, Member } = require('../src/models');

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

afterEach(async () => {
  await Member.destroy({ where: {}, truncate: true });
});

afterAll(async () => {
  await sequelize.close();
});

const validMember = {
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  membershipPlan: 'PREMIUM',
};

describe('GET /api/health', () => {
  it('returns ok status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('POST /api/members', () => {
  it('creates a member with the given fields', async () => {
    const res = await request(app).post('/api/members').send(validMember);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
      membershipPlan: 'PREMIUM',
      status: 'ACTIVE',
    });
    expect(res.body.id).toEqual(expect.any(Number));
  });

  it('defaults membershipPlan to BASIC and status to ACTIVE when omitted', async () => {
    const res = await request(app).post('/api/members').send({
      firstName: 'John',
      lastName: 'Smith',
      email: 'john@example.com',
    });

    expect(res.status).toBe(201);
    expect(res.body.membershipPlan).toBe('BASIC');
    expect(res.body.status).toBe('ACTIVE');
  });

  it('rejects creation when a required field is missing', async () => {
    const res = await request(app).post('/api/members').send({
      lastName: 'Doe',
      email: 'missing-first@example.com',
    });

    expect(res.status).toBe(400);
  });

  it('rejects a duplicate email', async () => {
    await request(app).post('/api/members').send(validMember);
    const res = await request(app)
      .post('/api/members')
      .send({ ...validMember, firstName: 'Other' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/members', () => {
  it('lists all members', async () => {
    await request(app).post('/api/members').send(validMember);

    const res = await request(app).get('/api/members');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].email).toBe(validMember.email);
  });

  it('returns an empty list when there are no members', async () => {
    const res = await request(app).get('/api/members');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /api/members/:id', () => {
  it('gets a member by id', async () => {
    const created = await request(app).post('/api/members').send(validMember);

    const res = await request(app).get(`/api/members/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(validMember.email);
  });

  it('returns 404 for an unknown member id', async () => {
    const res = await request(app).get('/api/members/999999');

    expect(res.status).toBe(404);
  });
});

describe('PUT /api/members/:id', () => {
  it('updates a member', async () => {
    const created = await request(app).post('/api/members').send(validMember);

    const res = await request(app)
      .put(`/api/members/${created.body.id}`)
      .send({ status: 'SUSPENDED' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUSPENDED');
  });

  it('returns 404 when updating an unknown member', async () => {
    const res = await request(app).put('/api/members/999999').send({ status: 'SUSPENDED' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/members/:id', () => {
  it('deletes a member', async () => {
    const created = await request(app).post('/api/members').send(validMember);

    const del = await request(app).delete(`/api/members/${created.body.id}`);
    expect(del.status).toBe(204);

    const after = await request(app).get(`/api/members/${created.body.id}`);
    expect(after.status).toBe(404);
  });

  it('returns 404 when deleting an unknown member', async () => {
    const res = await request(app).delete('/api/members/999999');

    expect(res.status).toBe(404);
  });
});

describe('POST /api/members/:id/merge', () => {
  const paymentsServiceUrl = (
    process.env.PAYMENTS_SERVICE_URL || 'http://localhost:3001'
  ).replace(/\/+$/, '');
  const mergeUrl = `${paymentsServiceUrl}/api/payments/merge`;

  const keptAccount = {
    firstName: 'Kept',
    lastName: 'Account',
    email: 'kept@example.com',
    membershipPlan: 'PREMIUM',
  };

  const duplicateAccount = {
    firstName: 'Duplicate',
    lastName: 'Account',
    email: 'duplicate@example.com',
    membershipPlan: 'STANDARD',
  };

  const originalFetch = global.fetch;
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ moved: 2 }) });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  async function createPair() {
    const kept = await request(app).post('/api/members').send(keptAccount);
    const duplicate = await request(app).post('/api/members').send(duplicateAccount);
    return { kept, duplicate };
  }

  it('merges the duplicate into the kept member', async () => {
    const { kept, duplicate } = await createPair();

    const res = await request(app)
      .post(`/api/members/${kept.body.id}/merge`)
      .send({ duplicateMemberId: duplicate.body.id });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(kept.body.id);

    const after = await request(app).get(`/api/members/${duplicate.body.id}`);
    expect(after.status).toBe(404);
  });

  it('leaves the kept member details unchanged', async () => {
    const { kept, duplicate } = await createPair();

    await request(app)
      .post(`/api/members/${kept.body.id}/merge`)
      .send({ duplicateMemberId: duplicate.body.id });

    const res = await request(app).get(`/api/members/${kept.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: kept.body.id,
      firstName: keptAccount.firstName,
      lastName: keptAccount.lastName,
      email: keptAccount.email,
      membershipPlan: keptAccount.membershipPlan,
      status: kept.body.status,
    });
  });

  it('sends the duplicate and the kept account to the payments service', async () => {
    const { kept, duplicate } = await createPair();

    await request(app)
      .post(`/api/members/${kept.body.id}/merge`)
      .send({ duplicateMemberId: duplicate.body.id });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(mergeUrl);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      fromMemberId: duplicate.body.id,
      toMemberId: kept.body.id,
    });
  });

  it('rejects merging an account into itself', async () => {
    const { kept } = await createPair();

    const res = await request(app)
      .post(`/api/members/${kept.body.id}/merge`)
      .send({ duplicateMemberId: kept.body.id });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const after = await request(app).get(`/api/members/${kept.body.id}`);
    expect(after.status).toBe(200);
    expect(after.body.email).toBe(keptAccount.email);
  });

  it('returns 404 when the kept account does not exist', async () => {
    const { duplicate } = await createPair();

    const res = await request(app)
      .post('/api/members/999999/merge')
      .send({ duplicateMemberId: duplicate.body.id });

    expect(res.status).toBe(404);
    expect(res.body.message).toContain('999999');
    expect(fetchMock).not.toHaveBeenCalled();

    const after = await request(app).get(`/api/members/${duplicate.body.id}`);
    expect(after.status).toBe(200);
  });

  it('returns 404 when the duplicate account does not exist', async () => {
    const { kept } = await createPair();

    const res = await request(app)
      .post(`/api/members/${kept.body.id}/merge`)
      .send({ duplicateMemberId: 999999 });

    expect(res.status).toBe(404);
    expect(res.body.message).toContain('999999');
    expect(fetchMock).not.toHaveBeenCalled();

    const after = await request(app).get(`/api/members/${kept.body.id}`);
    expect(after.status).toBe(200);
  });

  it('rolls the merge back when the payments service is unreachable', async () => {
    const { kept, duplicate } = await createPair();
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3001'));

    const res = await request(app)
      .post(`/api/members/${kept.body.id}/merge`)
      .send({ duplicateMemberId: duplicate.body.id });

    expect(res.status).toBe(502);

    const keptAfter = await request(app).get(`/api/members/${kept.body.id}`);
    expect(keptAfter.status).toBe(200);
    expect(keptAfter.body.email).toBe(keptAccount.email);

    const duplicateAfter = await request(app).get(`/api/members/${duplicate.body.id}`);
    expect(duplicateAfter.status).toBe(200);
    expect(duplicateAfter.body.email).toBe(duplicateAccount.email);
  });

  it('rolls the merge back when the payments service answers with an error', async () => {
    const { kept, duplicate } = await createPair();
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    const res = await request(app)
      .post(`/api/members/${kept.body.id}/merge`)
      .send({ duplicateMemberId: duplicate.body.id });

    expect(res.status).toBe(502);

    const keptAfter = await request(app).get(`/api/members/${kept.body.id}`);
    expect(keptAfter.status).toBe(200);

    const duplicateAfter = await request(app).get(`/api/members/${duplicate.body.id}`);
    expect(duplicateAfter.status).toBe(200);
  });

  it('merges successfully when the duplicate has no payments', async () => {
    const { kept, duplicate } = await createPair();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ moved: 0 }) });

    const res = await request(app)
      .post(`/api/members/${kept.body.id}/merge`)
      .send({ duplicateMemberId: duplicate.body.id });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(kept.body.id);
  });
});

describe('unknown routes', () => {
  it('returns 404 for an undefined route', async () => {
    const res = await request(app).get('/api/not-a-real-route');

    expect(res.status).toBe(404);
  });
});
