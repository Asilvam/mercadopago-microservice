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
  handleLegacyWebhook(@Query('id') id: string, @Query('topic') topic: string) {
    this.logger.log(`[Webhook Legado] Notificación recibida. Topico: ${topic}, ID: ${id}`);
    if (topic === 'payment' && id) {
      this.mercadopagoService.handleWebhook(id);
    }
    // 3. Respondemos 200 OK inmediatamente, sin esperar el procesamiento
    return;
  }
}
