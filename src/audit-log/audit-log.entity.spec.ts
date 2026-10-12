import { AuditLogSchema } from './audit-log.entity';

describe('AuditLogSchema migration compatibility', () => {
  it('creates audit indexes explicitly instead of racing startup migration', () => {
    expect(AuditLogSchema.get('autoIndex')).toBe(false);
  });

  it('keeps historical records without eventId outside the unique index', () => {
    const index = AuditLogSchema.indexes().find(([fields]) => fields.eventId === 1);

    expect(index).toEqual([
      { eventId: 1 },
      expect.objectContaining({
        unique: true,
        partialFilterExpression: { eventId: { $type: 'string' } },
      }),
    ]);
    expect(AuditLogSchema.path('eventId').options.required).toBe(true);
  });

  it('does not deduplicate business events by entity and action', () => {
    const legacyIndex = AuditLogSchema.indexes().find(([fields, options]) =>
      fields.entityType === 1 && fields.entityId === 1 && fields.action === 1 && options.unique,
    );
    expect(legacyIndex).toBeUndefined();
  });

  it('applies TTL only to documents with expiresAt, without assigning it to legacy logs', () => {
    const ttl = AuditLogSchema.indexes().find(([fields]) => fields.expiresAt === 1);
    expect(ttl?.[1].expireAfterSeconds).toBe(0);
    expect(AuditLogSchema.path('expiresAt').options.required).toBe(false);
    expect(AuditLogSchema.path('expiresAt').options.default).toBeUndefined();
  });
});
