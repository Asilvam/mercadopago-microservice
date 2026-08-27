import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MercadopagoService } from './mercadopago.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-log/audit-log.constants';

// Mock del SDK de MercadoPago
jest.mock('mercadopago', () => {
  const mockPreferenceCreate = jest.fn();
  const mockPaymentGet = jest.fn();
  return {
    MercadoPagoConfig: jest.fn().mockImplementation(() => ({})),
    Preference: jest.fn().mockImplementation(() => ({
      create: mockPreferenceCreate,
    })),
    Payment: jest.fn().mockImplementation(() => ({
      get: mockPaymentGet,
    })),
    __mockPreferenceCreate: mockPreferenceCreate,
    __mockPaymentGet: mockPaymentGet,
  };
});

// Mock de fetch global
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Mock de uuid
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'aaaabbbb-cccc-dddd-eeee-ffffgggghhhh'),
}));

describe('MercadopagoService', () => {
  let service: MercadopagoService;
  let auditLogService: jest.Mocked<AuditLogService>;
  let mockPreferenceCreate: jest.Mock;
  let mockPaymentGet: jest.Mock;

  const envConfig: Record<string, string> = {
    MP_ACCESS_TOKEN: 'TEST-access-token-123',
    BACKEND_URL: 'http://localhost:4000',
    MP_SUCCESS_URL: 'http://localhost/success',
    MP_FAILURE_URL: 'http://localhost/failure',
    MP_PENDING_URL: 'http://localhost/pending',
    NOTIFICATION_URL: 'http://localhost/webhook',
  };

  const mockConfigService = {
    get: jest.fn((key: string) => envConfig[key]),
  };

  const mockAuditLogService = {
    createAuditLog: jest.fn().mockResolvedValue(undefined),
    setMongoConnectionStatus: jest.fn(),
  };

  beforeEach(async () => {
    // Obtener referencias a los mocks del SDK
    const mp = require('mercadopago');
    mockPreferenceCreate = mp.__mockPreferenceCreate;
    mockPaymentGet = mp.__mockPaymentGet;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MercadopagoService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AuditLogService, useValue: mockAuditLogService },
      ],
    }).compile();

    service = module.get<MercadopagoService>(MercadopagoService);
    auditLogService = module.get(AuditLogService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('createPaymentPreference', () => {
    const validDto = {
      courtId: 'cancha-1',
      date: '2026-09-01',
      time: '18:00',
      player1: 'Juan Pérez',
      amount: 15000,
      idCourtReserve: 'reserve-001',
    };

    it('debería crear una preferencia y retornar preferenceId e initPoint', async () => {
      mockPreferenceCreate.mockResolvedValue({
        id: 'pref-abc-123',
        init_point: 'https://mercadopago.cl/checkout/pref-abc-123',
      });

      const result = await service.createPaymentPreference(validDto as any);

      expect(result).toEqual({
        preferenceId: 'pref-abc-123',
        initPoint: 'https://mercadopago.cl/checkout/pref-abc-123',
      });
    });

    it('debería enviar los datos correctos al SDK de MercadoPago', async () => {
      mockPreferenceCreate.mockResolvedValue({ id: 'pref-123', init_point: '' });

      await service.createPaymentPreference(validDto as any);

      expect(mockPreferenceCreate).toHaveBeenCalledWith({
        body: expect.objectContaining({
          items: [
            expect.objectContaining({
              title: 'Reserva Jugador: Juan Pérez',
              description: expect.stringContaining('cancha-1'),
              quantity: 1,
              currency_id: 'CLP',
              unit_price: 15000,
              category_id: 'services',
            }),
          ],
          external_reference: 'reserve-001',
          auto_return: 'approved',
          notification_url: 'http://localhost/webhook',
          back_urls: {
            success: 'http://localhost/success',
            failure: 'http://localhost/failure',
            pending: 'http://localhost/pending',
          },
          metadata: {
            courtId: 'cancha-1',
            date: '2026-09-01',
            time: '18:00',
            player1: 'Juan Pérez',
          },
        }),
      });
    });

    it('debería lanzar error si el SDK de MercadoPago falla', async () => {
      mockPreferenceCreate.mockRejectedValue(new Error('Invalid access token'));

      await expect(service.createPaymentPreference(validDto as any)).rejects.toThrow(
        'Invalid access token',
      );
    });
  });

  describe('handleWebhook', () => {
    const paymentId = 'pay-12345';
    const eventType = 'payment';
    const requestMetadata = { source: 'body', ipAddress: '127.0.0.1' };

    const approvedPayment = {
      status: 'approved',
      external_reference: 'reserve-001',
      payer: { email: 'buyer@test.com' },
      transaction_amount: 15000,
      currency_id: 'CLP',
    };

    const rejectedPayment = {
      ...approvedPayment,
      status: 'rejected',
    };

    const pendingPayment = {
      ...approvedPayment,
      status: 'pending',
    };

    beforeEach(() => {
      mockFetch.mockResolvedValue({ ok: true });
    });

    it('debería registrar audit log WEBHOOK_RECEIVED al inicio', async () => {
      mockPaymentGet.mockResolvedValue(approvedPayment);

      await service.handleWebhook(paymentId, eventType, requestMetadata);

      expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'PAYMENT',
          entityId: paymentId,
          action: AUDIT_ACTIONS.WEBHOOK_RECEIVED,
        }),
      );
    });

    it('debería consultar el pago con el SDK de MercadoPago', async () => {
      mockPaymentGet.mockResolvedValue(approvedPayment);

      await service.handleWebhook(paymentId, eventType, requestMetadata);

      expect(mockPaymentGet).toHaveBeenCalledWith({ id: paymentId });
    });

    describe('pago aprobado', () => {
      beforeEach(() => {
        mockPaymentGet.mockResolvedValue(approvedPayment);
      });

      it('debería registrar audit log WEBHOOK_PAYMENT_APPROVED', async () => {
        await service.handleWebhook(paymentId, eventType, requestMetadata);

        expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AUDIT_ACTIONS.WEBHOOK_PAYMENT_APPROVED,
          }),
        );
      });

      it('debería llamar a updateReservationState con la external_reference', async () => {
        await service.handleWebhook(paymentId, eventType, requestMetadata);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4000/court-reserve/UpdateStateReserve/reserve-001',
          expect.objectContaining({ method: 'POST' }),
        );
      });

      it('debería registrar RESERVATION_UPDATE_OK al actualizar exitosamente', async () => {
        await service.handleWebhook(paymentId, eventType, requestMetadata);

        expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            entityType: 'COURT_RESERVE',
            entityId: 'reserve-001',
            action: AUDIT_ACTIONS.RESERVATION_UPDATE_OK,
          }),
        );
      });

      it('debería enviar correo de confirmación', async () => {
        await service.handleWebhook(paymentId, eventType, requestMetadata);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4000/court-reserve/emailconfirmation',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('reserve-001'),
          }),
        );
      });

      it('debería registrar EMAIL_CONFIRMATION_OK al enviar correo exitosamente', async () => {
        await service.handleWebhook(paymentId, eventType, requestMetadata);

        expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AUDIT_ACTIONS.EMAIL_CONFIRMATION_OK,
          }),
        );
      });
    });

    describe('pago rechazado', () => {
      beforeEach(() => {
        mockPaymentGet.mockResolvedValue(rejectedPayment);
      });

      it('debería registrar audit log WEBHOOK_PAYMENT_REJECTED', async () => {
        await service.handleWebhook(paymentId, eventType, requestMetadata);

        expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AUDIT_ACTIONS.WEBHOOK_PAYMENT_REJECTED,
          }),
        );
      });

      it('debería NO llamar a updateReservationState', async () => {
        await service.handleWebhook(paymentId, eventType, requestMetadata);

        // Solo emailconfirmation debería llamarse, no UpdateStateReserve
        const updateCalls = mockFetch.mock.calls.filter(
          (call) => call[0].includes('UpdateStateReserve'),
        );
        expect(updateCalls).toHaveLength(0);
      });

      it('debería enviar correo de confirmación con status rejected', async () => {
        await service.handleWebhook(paymentId, eventType, requestMetadata);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4000/court-reserve/emailconfirmation',
          expect.objectContaining({
            body: JSON.stringify({
              reservationId: 'reserve-001',
              paymentStatus: 'rejected',
            }),
          }),
        );
      });
    });

    describe('pago pendiente', () => {
      beforeEach(() => {
        mockPaymentGet.mockResolvedValue(pendingPayment);
      });

      it('debería registrar audit log WEBHOOK_PAYMENT_PENDING', async () => {
        await service.handleWebhook(paymentId, eventType, requestMetadata);

        expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AUDIT_ACTIONS.WEBHOOK_PAYMENT_PENDING,
          }),
        );
      });

      it('debería NO actualizar reserva', async () => {
        await service.handleWebhook(paymentId, eventType, requestMetadata);

        const updateCalls = mockFetch.mock.calls.filter(
          (call) => call[0].includes('UpdateStateReserve'),
        );
        expect(updateCalls).toHaveLength(0);
      });
    });

    describe('manejo de errores', () => {
      it('debería registrar WEBHOOK_ERROR si el SDK falla al consultar el pago', async () => {
        mockPaymentGet.mockRejectedValue(new Error('Payment not found'));

        await service.handleWebhook(paymentId, eventType, requestMetadata);

        expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AUDIT_ACTIONS.WEBHOOK_ERROR,
            metadata: expect.objectContaining({
              error: 'Payment not found',
            }),
          }),
        );
      });

      it('debería NO lanzar excepción si el SDK falla', async () => {
        mockPaymentGet.mockRejectedValue(new Error('Network error'));

        await expect(
          service.handleWebhook(paymentId, eventType, requestMetadata),
        ).resolves.toBeUndefined();
      });

      it('debería registrar RESERVATION_UPDATE_ERROR si falla la actualización', async () => {
        mockPaymentGet.mockResolvedValue(approvedPayment);
        mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

        await service.handleWebhook(paymentId, eventType, requestMetadata);

        expect(auditLogService.createAuditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AUDIT_ACTIONS.RESERVATION_UPDATE_ERROR,
          }),
        );
      });
    });

    describe('external_reference vacío', () => {
      it('debería NO enviar correo si external_reference es vacío', async () => {
        mockPaymentGet.mockResolvedValue({
          ...rejectedPayment,
          external_reference: undefined,
        });

        await service.handleWebhook(paymentId, eventType, requestMetadata);

        const emailCalls = mockFetch.mock.calls.filter(
          (call) => call[0].includes('emailconfirmation'),
        );
        expect(emailCalls).toHaveLength(0);
      });
    });
  });
});
