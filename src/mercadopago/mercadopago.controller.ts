import { Controller, Post, HttpCode, Logger, Query, Body, ValidationPipe } from '@nestjs/common';
import { MercadopagoService } from './mercadopago.service';
import { CreatePaymentDTO } from './dto/create-payment.dto';

@Controller('mercadopago')
export class MercadopagoController {
  private readonly logger = new Logger(MercadopagoController.name);
  constructor(private readonly mercadopagoService: MercadopagoService) {}

  @Post('create-preference')
  createPaymentPreference(@Body(new ValidationPipe()) paymentDTO: CreatePaymentDTO) {
    return this.mercadopagoService.createPaymentPreference(paymentDTO);
  }

  @Post('webhook') // Mercado Pago usa POST aunque los datos estén en la URL
  @HttpCode(200) // Siempre responder 200 OK rápido
  handleLegacyWebhook(@Query('data.id') dataId: string, @Query('type') type: string) {
    this.logger.log(`[Webhook Legado] Notificación recibida. Tipo: ${type}, ID: ${dataId}`);
    if (type === 'payment' && dataId) {
      this.mercadopagoService.handleWebhook(dataId);
    }
    // 3. Respondemos 200 OK inmediatamente, sin esperar el procesamiento
    return;
  }
}
