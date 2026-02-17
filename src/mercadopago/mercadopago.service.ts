import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Payment, Preference } from 'mercadopago';
import { CreateMpDto } from './dto/create-mp.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class MercadopagoService {
  private readonly logger = new Logger(MercadopagoService.name);
  private readonly client: MercadoPagoConfig;

  constructor(private configService: ConfigService) {
    const accessToken = this.configService.get<string>('MP_ACCESS_TOKEN');
    if (!accessToken) {
      throw new Error('MP_ACCESS_TOKEN no está definido en las variables de entorno');
    }
    this.client = new MercadoPagoConfig({
      accessToken: accessToken,
    });
  }

  private async updateReservationState(reservationId: string) {
    try {
      const mainBackendUrl = this.configService.get<string>('BACKEND_URL');
      const response = await fetch(`${mainBackendUrl}/court-reserve/UpdateStateReserve/${reservationId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      this.logger.log(`Reserva ${reservationId} actualizada exitosamente`);
    } catch (error) {
      this.logger.error(`Error actualizando reserva ${reservationId}:`, error.message);
      throw error;
    }
  }

  async createPaymentPreference(paymentDTO: CreateMpDto) {
    const successUrl = this.configService.get<string>('MP_SUCCESS_URL');
    const failureUrl = this.configService.get<string>('MP_FAILURE_URL');
    const pendingUrl = this.configService.get<string>('MP_PENDING_URL');
    const notificationUrl = this.configService.get<string>('NOTIFICATION_URL');
    this.logger.log('[createPaymentPreference] Creando preferencia de pago...');
    try {
      const { courtId, date, time, player1, amount, idCourtReserve } = paymentDTO;
      const preferenceBody = {
        items: [
          {
            id: uuidv4().replace(/-/g, '').substring(0, 6),
            title: `Reserva Nocturna - Court ${courtId}`,
            description: `Fecha: ${date} - Turno: ${time} - Jugador: ${player1}`,
            quantity: 1,
            currency_id: 'CLP',
            unit_price: amount,
            category_id: 'services',
          },
        ],
        external_reference: idCourtReserve, // ID único de tu sistema
        back_urls: {
          success: successUrl,
          failure: failureUrl,
          pending: pendingUrl,
        },
        auto_return: 'approved',
        notification_url: notificationUrl,
        metadata: {
          courtId,
          date,
          time,
          player1,
        },
      };
      const preference = new Preference(this.client);
      const result = await preference.create({ body: preferenceBody });
      this.logger.log('[createPaymentPreference] Preferencia creada exitosamente.');
      return {
        preferenceId: result.id,
        initPoint: result.init_point,
      };
    } catch (error) {
      this.logger.error('Error al crear la preferencia', error.message);
      throw new Error(error.message);
    }
  }

  /**
   * Maneja la notificación de Webhook recibida de Mercado Pago.
   * @param paymentId El ID del pago notificado (viene de body.data.id)
   */
  async handleWebhook(paymentId: string) {
    this.logger.log(`[Webhook] Recibiendo Payment ID: ${paymentId}`);

    try {
      const paymentSDK = new Payment(this.client);
      const paymentInfo = await paymentSDK.get({ id: paymentId });

      this.logger.log(`[Webhook] Estado del pago: ${paymentInfo.status}`);
      this.logger.log(`[Webhook] External Reference: ${paymentInfo.external_reference}`);

      if (paymentInfo.status === 'approved') {
        this.logger.log('¡PAGO APROBADO!');
        this.logger.log(`ID Reserva (external_reference): ${paymentInfo.external_reference}`);
        this.logger.log(`Email del pagador: ${paymentInfo.payer.email}`);
        this.logger.log(`Monto: ${paymentInfo.transaction_amount} ${paymentInfo.currency_id}`);
        await this.updateReservationState(paymentInfo.external_reference);
      } else {
        // El pago no fue aprobado (ej. "rejected", "pending")
        this.logger.warn(`[Webhook] Pago NO aprobado. Estado: ${paymentInfo.status}`);
      }
    } catch (error) {
      this.logger.error(`[Webhook] Error al procesar el pago ${paymentId}`, error.message);
    }
  }
}
