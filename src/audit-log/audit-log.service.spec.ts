import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { AuditLogService } from './audit-log.service';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let mockModel: any;

  const createMockModel = () => {
    const saveFn = jest.fn().mockResolvedValue(undefined);
    const constructorFn: any = jest.fn().mockImplementation((data) => ({
      ...data,
      save: saveFn,
    }));
    constructorFn.exists = jest.fn().mockResolvedValue(null);
    constructorFn._saveFn = saveFn;
    return constructorFn;
  };

  beforeEach(async () => {
    mockModel = createMockModel();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogService,
        { provide: getModelToken('AuditLog'), useValue: mockModel },
      ],
    }).compile();

    service = module.get<AuditLogService>(AuditLogService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createAuditLog', () => {
    const basePayload = {
      entityType: 'PAYMENT',
      entityId: 'pay-123',
      action: 'WEBHOOK_RECEIVED',
      description: 'Test audit log',
    };

    it('debería crear un audit log cuando MongoDB está conectado', async () => {
      await service.createAuditLog(basePayload);

      expect(mockModel).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'PAYMENT',
          entityId: 'pay-123',
          action: 'WEBHOOK_RECEIVED',
          description: 'Test audit log',
          performedBy: 'SYSTEM',
        }),
      );
      expect(mockModel._saveFn).toHaveBeenCalled();
    });

    it('debería usar "SYSTEM" como performedBy por defecto', async () => {
      await service.createAuditLog(basePayload);

      expect(mockModel).toHaveBeenCalledWith(
        expect.objectContaining({ performedBy: 'SYSTEM' }),
      );
    });

    it('debería usar el performedBy proporcionado', async () => {
      await service.createAuditLog({ ...basePayload, performedBy: 'user-456' });

      expect(mockModel).toHaveBeenCalledWith(
        expect.objectContaining({ performedBy: 'user-456' }),
      );
    });

    it('debería incluir timestamp', async () => {
      await service.createAuditLog(basePayload);

      expect(mockModel).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: expect.any(Date),
        }),
      );
    });

    it('debería incluir metadata cuando se proporciona', async () => {
      const metadata = { source: 'body', eventType: 'payment' };
      await service.createAuditLog({ ...basePayload, metadata });

      expect(mockModel).toHaveBeenCalledWith(
        expect.objectContaining({ metadata }),
      );
    });

    it('debería usar metadata vacío cuando no se proporciona', async () => {
      await service.createAuditLog(basePayload);

      expect(mockModel).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: {} }),
      );
    });
  });

  describe('deduplicación', () => {
    const payload = {
      entityType: 'PAYMENT',
      entityId: 'pay-123',
      action: 'WEBHOOK_RECEIVED',
      description: 'Duplicado',
    };

    it('debería ignorar si ya existe un audit log con mismo entityType+entityId+action', async () => {
      mockModel.exists.mockResolvedValue({ _id: 'existing-id' });

      await service.createAuditLog(payload);

      expect(mockModel.exists).toHaveBeenCalledWith({
        entityType: 'PAYMENT',
        entityId: 'pay-123',
        action: 'WEBHOOK_RECEIVED',
      });
      expect(mockModel._saveFn).not.toHaveBeenCalled();
    });

    it('debería crear si no existe un audit log previo', async () => {
      mockModel.exists.mockResolvedValue(null);

      await service.createAuditLog(payload);

      expect(mockModel._saveFn).toHaveBeenCalled();
    });

    it('debería saltar verificación de duplicados si entityId es undefined', async () => {
      const payloadSinId = {
        entityType: 'SYSTEM',
        action: 'STARTUP',
        description: 'Sin entityId',
      };

      await service.createAuditLog(payloadSinId);

      expect(mockModel.exists).not.toHaveBeenCalled();
      expect(mockModel._saveFn).toHaveBeenCalled();
    });
  });

  describe('tolerancia a fallos — MongoDB desconectado', () => {
    const payload = {
      entityType: 'PAYMENT',
      entityId: 'pay-123',
      action: 'WEBHOOK_RECEIVED',
      description: 'Test',
    };

    it('debería NO crear audit log cuando MongoDB está desconectado', async () => {
      service.setMongoConnectionStatus(false);

      await service.createAuditLog(payload);

      expect(mockModel).not.toHaveBeenCalled();
      expect(mockModel._saveFn).not.toHaveBeenCalled();
    });

    it('debería reanudar audit logs cuando MongoDB se reconecta', async () => {
      service.setMongoConnectionStatus(false);
      await service.createAuditLog(payload);
      expect(mockModel._saveFn).not.toHaveBeenCalled();

      service.setMongoConnectionStatus(true);
      await service.createAuditLog(payload);
      expect(mockModel._saveFn).toHaveBeenCalled();
    });

    it('debería NO lanzar excepción cuando MongoDB está desconectado', async () => {
      service.setMongoConnectionStatus(false);

      await expect(service.createAuditLog(payload)).resolves.toBeUndefined();
    });
  });

  describe('manejo de errores', () => {
    const payload = {
      entityType: 'PAYMENT',
      entityId: 'pay-123',
      action: 'WEBHOOK_RECEIVED',
      description: 'Test',
    };

    it('debería ignorar silenciosamente errores de duplicado (code 11000)', async () => {
      mockModel._saveFn.mockRejectedValue({ code: 11000 });

      await expect(service.createAuditLog(payload)).resolves.toBeUndefined();
    });

    it('debería NO lanzar excepción en errores genéricos de MongoDB', async () => {
      mockModel._saveFn.mockRejectedValue(new Error('Connection timeout'));

      await expect(service.createAuditLog(payload)).resolves.toBeUndefined();
    });
  });
});
