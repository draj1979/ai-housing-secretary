import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import FormData from 'form-data';
import { registerAdminDocumentsRoutes } from './adminDocumentsRoutes.js';
import { mintAdminToken, type AdminAuthConfig } from './adminAuth.js';

const CONFIG: AdminAuthConfig = { secret: 'test-admin-secret', expiresIn: '1h' };

function buildApp(
  documentsModule: {
    ingest: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  },
  documentStorage: { upload: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> },
) {
  const app = Fastify();
  app.register(multipart);
  registerAdminDocumentsRoutes(app, { authConfig: CONFIG, documentsModule, documentStorage });
  return app;
}

function bearer(role: 'secretary' | 'read_only') {
  return `Bearer ${mintAdminToken(CONFIG, { sub: 'x', role })}`;
}

describe('GET /admin/documents', () => {
  it('returns documents and the category list for either role', async () => {
    const documentsModule = {
      ingest: vi.fn(),
      list: vi.fn().mockResolvedValue([
        {
          id: 'd1',
          title: 'Bye-Laws',
          category: 'bye_laws',
          sourceUri: 'gs://b/documents/x',
          version: 1,
          uploadedAt: new Date(),
        },
      ]),
      remove: vi.fn(),
    };
    const documentStorage = { upload: vi.fn(), delete: vi.fn() };
    const app = buildApp(documentsModule, documentStorage);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/documents',
      headers: { authorization: bearer('read_only') },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.documents).toHaveLength(1);
    expect(body.categories.map((c: { id: string }) => c.id)).toContain('bye_laws');
  });

  it('401s with no token', async () => {
    const documentsModule = { ingest: vi.fn(), list: vi.fn(), remove: vi.fn() };
    const app = buildApp(documentsModule, { upload: vi.fn(), delete: vi.fn() });
    const response = await app.inject({ method: 'GET', url: '/admin/documents' });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /admin/documents', () => {
  it('uploads, stores, and ingests a valid text file', async () => {
    const documentsModule = {
      ingest: vi.fn().mockResolvedValue({
        documentId: 'd1',
        title: 'Parking Policy',
        category: 'parking_policy',
        version: 1,
        chunkCount: 1,
        changed: true,
      }),
      list: vi.fn(),
      remove: vi.fn(),
    };
    const documentStorage = {
      upload: vi.fn().mockResolvedValue({
        objectPath: 'documents/x-parking.txt',
        gcsUri: 'gs://bucket/documents/x-parking.txt',
      }),
      delete: vi.fn(),
    };
    const app = buildApp(documentsModule, documentStorage);

    const form = new FormData();
    form.append('title', 'Parking Policy');
    form.append('category', 'parking_policy');
    form.append('file', Buffer.from('Visitor parking is limited to slots 1-10.'), {
      filename: 'parking.txt',
      contentType: 'text/plain',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/documents',
      headers: { authorization: bearer('secretary'), ...form.getHeaders() },
      payload: form.getBuffer(),
    });

    expect(response.statusCode).toBe(201);
    expect(documentStorage.upload).toHaveBeenCalledWith(
      'parking.txt',
      expect.any(Buffer),
      'text/plain',
    );
    expect(documentsModule.ingest).toHaveBeenCalledWith({
      title: 'Parking Policy',
      category: 'parking_policy',
      sourceUri: 'gs://bucket/documents/x-parking.txt',
      content: 'Visitor parking is limited to slots 1-10.',
    });
  });

  it('403s a read_only token', async () => {
    const documentsModule = { ingest: vi.fn(), list: vi.fn(), remove: vi.fn() };
    const documentStorage = { upload: vi.fn(), delete: vi.fn() };
    const app = buildApp(documentsModule, documentStorage);

    const form = new FormData();
    form.append('title', 'X');
    form.append('category', 'bye_laws');
    form.append('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/documents',
      headers: { authorization: bearer('read_only'), ...form.getHeaders() },
      payload: form.getBuffer(),
    });

    expect(response.statusCode).toBe(403);
    expect(documentsModule.ingest).not.toHaveBeenCalled();
  });

  it('400s an invalid category', async () => {
    const documentsModule = { ingest: vi.fn(), list: vi.fn(), remove: vi.fn() };
    const documentStorage = { upload: vi.fn(), delete: vi.fn() };
    const app = buildApp(documentsModule, documentStorage);

    const form = new FormData();
    form.append('title', 'X');
    form.append('category', 'not_a_real_category');
    form.append('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/documents',
      headers: { authorization: bearer('secretary'), ...form.getHeaders() },
      payload: form.getBuffer(),
    });

    expect(response.statusCode).toBe(400);
    expect(documentStorage.upload).not.toHaveBeenCalled();
  });

  it('415s an unsupported file type', async () => {
    const documentsModule = { ingest: vi.fn(), list: vi.fn(), remove: vi.fn() };
    const documentStorage = { upload: vi.fn(), delete: vi.fn() };
    const app = buildApp(documentsModule, documentStorage);

    const form = new FormData();
    form.append('title', 'X');
    form.append('category', 'bye_laws');
    form.append('file', Buffer.from('not really a zip'), {
      filename: 'a.zip',
      contentType: 'application/zip',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/documents',
      headers: { authorization: bearer('secretary'), ...form.getHeaders() },
      payload: form.getBuffer(),
    });

    expect(response.statusCode).toBe(415);
    expect(documentStorage.upload).not.toHaveBeenCalled();
  });

  it('400s a missing title', async () => {
    const documentsModule = { ingest: vi.fn(), list: vi.fn(), remove: vi.fn() };
    const documentStorage = { upload: vi.fn(), delete: vi.fn() };
    const app = buildApp(documentsModule, documentStorage);

    const form = new FormData();
    form.append('category', 'bye_laws');
    form.append('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/documents',
      headers: { authorization: bearer('secretary'), ...form.getHeaders() },
      payload: form.getBuffer(),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('DELETE /admin/documents/:id', () => {
  it('removes the document row/chunks and its GCS object', async () => {
    const documentsModule = {
      ingest: vi.fn(),
      list: vi.fn(),
      remove: vi.fn().mockResolvedValue({ sourceUri: 'gs://bucket/documents/x-parking.txt' }),
    };
    const documentStorage = { upload: vi.fn(), delete: vi.fn() };
    const app = buildApp(documentsModule, documentStorage);

    const response = await app.inject({
      method: 'DELETE',
      url: '/admin/documents/d1',
      headers: { authorization: bearer('secretary') },
    });

    expect(response.statusCode).toBe(200);
    expect(documentStorage.delete).toHaveBeenCalledWith('documents/x-parking.txt');
  });

  it('404s a document id that does not exist', async () => {
    const documentsModule = {
      ingest: vi.fn(),
      list: vi.fn(),
      remove: vi.fn().mockResolvedValue(null),
    };
    const documentStorage = { upload: vi.fn(), delete: vi.fn() };
    const app = buildApp(documentsModule, documentStorage);

    const response = await app.inject({
      method: 'DELETE',
      url: '/admin/documents/nope',
      headers: { authorization: bearer('secretary') },
    });

    expect(response.statusCode).toBe(404);
    expect(documentStorage.delete).not.toHaveBeenCalled();
  });
});
