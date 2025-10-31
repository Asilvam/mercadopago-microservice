import {
  Controller,
  Post,
  Body,
  ValidationPipe,
  HttpCode,
  Logger, // Importar HttpCode
} from '@nestjs/common';
import { MercadopagoService } from './mercadopago.service';
import { CreatePaymentDTO } from './dto/create-payment.dto';
import { WebhookDTO } from './dto/webhook-data.dto'; // Importar DTO de Webhook

@Controller('mercadopago')
export class MercadopagoController {
  private readonly logger= new Logger(MercadopagoController.name);
  constructor(private readonly mercadopagoService: MercadopagoService) {}

  /**
   * Endpoint para crear una preferencia de pago.
   * Recibe los datos del pago y retorna la URL de pago (init_point).
   */
  @Post('create-preference')
  async createPaymentPreference(
    // Usamos ValidationPipe para activar las validaciones del DTO
    @Body(new ValidationPipe()) paymentDTO: CreatePaymentDTO,
  ) {
    return this.mercadopagoService.createPaymentPreference(paymentDTO);
  }

  /**
   * Endpoint de Webhook para recibir notificaciones de Mercado Pago.
   * @param body Notificación de Mercado Pago
   */
  @Post('webhook')
  @HttpCode(200) // 1. Responder siempre con "200 OK"
  async handleWebhook(@Body(new ValidationPipe()) body: WebhookDTO) {
    this.logger.log(`[Webhook] Notificación recibida. Acción: ${body.action}`);

    // 2. Filtra por la acción que te interesa (ej. 'payment.updated')
    if (
      body.action === 'payment.updated' ||
      body.action === 'payment.created'
    ) {
      const paymentId = body.data.id;

      // 3. Llama al servicio SIN "await"
      // Esto responde 200 OK inmediatamente a Mercado Pago
      // y procesa el pago en segundo plano para evitar timeouts.
      this.mercadopagoService.handleWebhook(paymentId);
    }

    // 4. No retornamos nada, solo el HttpCode 200
    return;
  }
}