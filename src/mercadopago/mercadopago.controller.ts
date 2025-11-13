import { Controller, Post, HttpCode, Logger, Query, Body, ValidationPipe } from '@nestjs/common';
import { MercadopagoService } from './mercadopago.service';
import { CreateMpDto } from './dto/create-mp.dto';

@Controller('mercadopago')
export class MercadopagoController {
  private readonly logger = new Logger(MercadopagoController.name);
  constructor(private readonly mercadopagoService: MercadopagoService) {}

  @Post('create-preference')
  createPaymentPreference(@Body(new ValidationPipe()) paymentDTO: CreateMpDto) {
    return this.mercadopagoService.createPaymentPreference(paymentDTO);
  }

  @Post('webhook') // Mercado Pago usa POST aunque los datos estén en la URL
  @HttpCode(200) // Siempre responder 200 OK rápido
  handleWebhook(@Query() query: Record<string, any>) {
    this.logger.log(`[Webhook] Notificación recibida. Query: ${JSON.stringify(query)}`);

    const type: string = query.type || 'unknown';
    const id: string = query['data.id'] || 'unknown';
    if (type === 'payment' && id) {
      this.mercadopagoService.handleWebhook(id);
    }
    // 3. Respondemos 200 OK inmediatamente, sin esperar el procesamiento
    return;
  }
}
