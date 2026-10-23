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

async function createMember(overrides = {}) {
  const res = await request(app).post('/api/members').send({ ...validMember, ...overrides });
  expect(res.status).toBe(201);
  return res.body;
}

describe('Member refund fields', () => {
  it('accepts CANCELLED alongside the existing statuses', () => {
    expect(Member.rawAttributes.status.values).toEqual([
      'ACTIVE',
      'INACTIVE',
      'SUSPENDED',
      'CANCELLED',
    ]);
  });

  it('accepts exactly the member-facing refund outcomes', () => {
    expect(Member.rawAttributes.refundStatus.values).toEqual(['PENDING', 'COMPLETED', 'FAILED']);
  });

  it('rejects a status outside the enum', async () => {
    const res = await request(app).post('/api/members').send({
      ...validMember,
      status: 'RETIRED',
    });

    expect(res.status).toBe(400);
  });

  it('rejects a refund status outside the enum', async () => {
    const created = await createMember();

    const res = await request(app)
      .put(`/api/members/${created.id}`)
      .send({ refundStatus: 'SUCCESS' });

    expect(res.status).toBe(400);
  });

  it('creates a member with no refund recorded and no follow-up needed', async () => {
    const created = await createMember();

    expect(created.status).toBe('ACTIVE');
    expect(created.refundNeedsFollowUp).toBe(false);

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.refundStatus).toBeNull();
    expect(after.body.refundNeedsFollowUp).toBe(false);
  });

  it('persists status CANCELLED through a partial update', async () => {
    const created = await createMember();

    const res = await request(app)
      .put(`/api/members/${created.id}`)
      .send({ status: 'CANCELLED' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('CANCELLED');
  });

  it.each(['PENDING', 'COMPLETED', 'FAILED'])('persists refundStatus %s', async (refundStatus) => {
    const created = await createMember();

    const res = await request(app)
      .put(`/api/members/${created.id}`)
      .send({ refundStatus });

    expect(res.status).toBe(200);
    expect(res.body.refundStatus).toBe(refundStatus);

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.refundStatus).toBe(refundStatus);
  });

  it('persists the staff follow-up flag', async () => {
    const created = await createMember();

    const res = await request(app)
      .put(`/api/members/${created.id}`)
      .send({ refundStatus: 'PENDING', refundNeedsFollowUp: true });

    expect(res.status).toBe(200);
    expect(res.body.refundNeedsFollowUp).toBe(true);

    const after = await request(app).get(`/api/members/${created.id}`);
    expect(after.status).toBe(200);
    expect(after.body.refundStatus).toBe('PENDING');
    expect(after.body.refundNeedsFollowUp).toBe(true);
  });
});
