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

describe('unknown routes', () => {
  it('returns 404 for an undefined route', async () => {
    const res = await request(app).get('/api/not-a-real-route');

    expect(res.status).toBe(404);
  });
});
