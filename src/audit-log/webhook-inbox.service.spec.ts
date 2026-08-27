import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEffect, WebhookEffectStatus, WebhookInbox, WebhookInboxStatus } from './webhook-inbox.entity';
import { WebhookInboxService } from './webhook-inbox.service';

describe('WebhookInboxService', () => {
  let service: WebhookInboxService;
  let inboxModel: {
    create: jest.Mock;
    findOneAndUpdate: jest.Mock;
    updateOne: jest.Mock;
  };
  let effectModel: {
    create: jest.Mock;
    findOneAndUpdate: jest.Mock;
    updateOne: jest.Mock;
  };

  const execResult = <T>(value: T) => ({ exec: jest.fn().mockResolvedValue(value) });

  beforeEach(async () => {
    inboxModel = {
      create: jest.fn().mockResolvedValue({}),
      findOneAndUpdate: jest.fn().mockReturnValue(execResult(null)),
      updateOne: jest.fn().mockReturnValue(execResult({ modifiedCount: 1 })),
    };
    effectModel = {
      create: jest.fn().mockResolvedValue({ effectKey: 'effect-key' }),
      findOneAndUpdate: jest.fn().mockReturnValue(execResult(null)),
      updateOne: jest.fn().mockReturnValue(execResult({ modifiedCount: 1 })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookInboxService,
        { provide: getModelToken(WebhookInbox.name), useValue: inboxModel },
        { provide: getModelToken(WebhookEffect.name), useValue: effectModel },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(
              (key: string) =>
                ({
                  WEBHOOK_MAX_ATTEMPTS: 4,
                  WEBHOOK_RETRY_BASE_MS: 1_000,
                  WEBHOOK_RETRY_MAX_MS: 60_000,
                  WEBHOOK_INBOX_RETENTION_DAYS: 30,
                  WEBHOOK_EFFECT_RETENTION_DAYS: 365,
                })[key],
            ),
          },
        },
      ],
    }).compile();

    service = module.get(WebhookInboxService);
  });

  const input = {
    eventKey: 'event-key',
    paymentId: 'payment-123',
    eventType: 'payment',
    requestId: 'request-123',
    payload: {
      authorization: 'Bearer secret',
      body: { data: { id: 'payment-123' } },
    },
  };

  it('persiste y sanitiza el webhook antes de aceptarlo', async () => {
    await expect(service.enqueue(input)).resolves.toEqual({ created: true, eventKey: 'event-key' });

    expect(inboxModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: 'event-key',
        status: WebhookInboxStatus.PENDING,
        attempts: 0,
        maxAttempts: 4,
        payload: expect.objectContaining({ authorization: '[REDACTED]' }),
        expiresAt: expect.any(Date),
      }),
    );
  });

  it('resuelve atómicamente dos inserciones concurrentes como original y duplicado', async () => {
    inboxModel.create.mockResolvedValueOnce({}).mockRejectedValueOnce({ code: 11000 });

    const results = await Promise.all([service.enqueue(input), service.enqueue(input)]);

    expect(results).toEqual([
      { created: true, eventKey: 'event-key' },
      { created: false, eventKey: 'event-key' },
    ]);
    expect(service.getMetrics()).toEqual(expect.objectContaining({ enqueued: 1, duplicates: 1 }));
  });

  it('reclama un evento mediante findOneAndUpdate atómico', async () => {
    const claimed = {
      eventKey: 'event-key',
      status: WebhookInboxStatus.PROCESSING,
      attempts: 1,
      maxAttempts: 4,
    };
    inboxModel.findOneAndUpdate.mockReturnValue(execResult(claimed));

    await expect(service.claimNext()).resolves.toEqual(claimed);
    expect(inboxModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ $expr: { $lt: ['$attempts', '$maxAttempts'] } }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: WebhookInboxStatus.PROCESSING }),
        $inc: { attempts: 1 },
      }),
      expect.objectContaining({ new: true }),
    );
  });

  it('programa reintento con backoff y conserva FAILED como estado observable', async () => {
    const event = {
      eventKey: 'event-key',
      attempts: 2,
      maxAttempts: 4,
    } as never;

    await service.markFailed(event, new Error('temporary failure'));

    const update = inboxModel.updateOne.mock.calls[0][1];
    expect(update.$set).toEqual(
      expect.objectContaining({
        status: WebhookInboxStatus.FAILED,
        lastError: 'temporary failure',
        nextAttemptAt: expect.any(Date),
      }),
    );
    expect(update.$set.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('detiene reintentos después del máximo configurado', async () => {
    const event = {
      eventKey: 'event-key',
      attempts: 4,
      maxAttempts: 4,
    } as never;

    await service.markFailed(event, new Error('permanent failure'));

    expect(inboxModel.updateOne.mock.calls[0][1].$set.nextAttemptAt).toBeNull();
    expect(service.getMetrics().permanentlyFailed).toBe(1);
  });

  it('ejecuta y confirma un efecto una sola vez', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);

    await expect(service.executeEffectOnce('effect-key', 'event-key', 'EMAIL', handler)).resolves.toBe(true);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(effectModel.updateOne).toHaveBeenCalledWith(
      { effectKey: 'effect-key', status: WebhookEffectStatus.PROCESSING },
      expect.objectContaining({
        $set: expect.objectContaining({ status: WebhookEffectStatus.SUCCEEDED }),
      }),
    );
  });

  it('omite un efecto que otra ejecución ya reclamó o completó', async () => {
    effectModel.create.mockRejectedValue({ code: 11000 });
    effectModel.findOneAndUpdate.mockReturnValue(execResult(null));
    const handler = jest.fn();

    await expect(service.executeEffectOnce('effect-key', 'event-key', 'EMAIL', handler)).resolves.toBe(false);

    expect(handler).not.toHaveBeenCalled();
    expect(service.getMetrics().sideEffectsSkipped).toBe(1);
  });
});
