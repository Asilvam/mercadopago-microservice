import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditLogService } from './audit-log.service';
import { AuditLog } from './audit-log.entity';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let mockModel: jest.Mock;
  let saveFn: jest.Mock;
  let dropIndex: jest.Mock;

  beforeEach(async () => {
    saveFn = jest.fn().mockResolvedValue(undefined);
    dropIndex = jest.fn().mockResolvedValue(undefined);
    mockModel = jest.fn().mockImplementation((data) => ({ ...data, save: saveFn }));
    Object.assign(mockModel, { collection: { dropIndex } });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogService,
        { provide: getModelToken(AuditLog.name), useValue: mockModel },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => (key === 'AUDIT_LOG_RETENTION_DAYS' ? 90 : undefined)) },
        },
      ],
    }).compile();

    service = module.get(AuditLogService);
  });

  afterEach(() => jest.clearAllMocks());

  const payload = {
    entityType: 'PAYMENT',
    entityId: 'pay-123',
    action: 'WEBHOOK_RECEIVED',
    description: 'Webhook recibido',
  };

  it('retira el índice único anterior durante la migración append-only', async () => {
    await service.onModuleInit();

    expect(dropIndex).toHaveBeenCalledWith('entityType_1_entityId_1_action_1');
  });

  it('tolera una instalación nueva donde el índice anterior no existe', async () => {
    dropIndex.mockRejectedValue({ code: 27, codeName: 'IndexNotFound' });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('persiste eventos append-only con eventId y retención', async () => {
    await service.createAuditLog(payload);
    await service.createAuditLog(payload);

    expect(mockModel).toHaveBeenCalledTimes(2);
    expect(saveFn).toHaveBeenCalledTimes(2);
    const first = mockModel.mock.calls[0][0];
    const second = mockModel.mock.calls[1][0];
    expect(first).toEqual(
      expect.objectContaining({
        eventId: expect.any(String),
        performedBy: 'SYSTEM',
        timestamp: expect.any(Date),
        expiresAt: expect.any(Date),
      }),
    );
    expect(first.eventId).not.toBe(second.eventId);
  });

  it('conserva correlación y actor explícitos', async () => {
    await service.createAuditLog({
      ...payload,
      performedBy: 'worker',
      correlationId: 'event-key',
      requestId: 'request-id',
      source: 'body',
      status: 'approved',
    });

    expect(mockModel).toHaveBeenCalledWith(
      expect.objectContaining({
        performedBy: 'worker',
        correlationId: 'event-key',
        requestId: 'request-id',
        source: 'body',
        status: 'approved',
      }),
    );
  });

  it('redacta secretos y enmascara correos en metadata', async () => {
    await service.createAuditLog({
      ...payload,
      metadata: {
        accessToken: 'secret-value',
        nested: { authorization: 'Bearer secret' },
        email: 'buyer@example.com',
      },
    });

    expect(mockModel).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          accessToken: '[REDACTED]',
          nested: { authorization: '[REDACTED]' },
          email: 'b***@example.com',
        },
      }),
    );
    expect(service.getMetrics().redactedFields).toBe(2);
  });

  it('propaga el fallo cuando Mongo está desconectado para permitir reintento', async () => {
    service.setMongoConnectionStatus(false);

    await expect(service.createAuditLog(payload)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(saveFn).not.toHaveBeenCalled();
    expect(service.getMetrics().rejectedWhileDisconnected).toBe(1);
  });

  it('reanuda la persistencia después de reconectar', async () => {
    service.setMongoConnectionStatus(false);
    await expect(service.createAuditLog(payload)).rejects.toBeDefined();

    service.setMongoConnectionStatus(true);
    await expect(service.createAuditLog(payload)).resolves.toBeUndefined();
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it('propaga errores de escritura y actualiza métricas', async () => {
    saveFn.mockRejectedValue(new Error('Connection timeout'));

    await expect(service.createAuditLog(payload)).rejects.toThrow('Connection timeout');
    expect(service.getMetrics().failed).toBe(1);
  });
});
