import { Controller, Post, HttpCode, Logger, Query, Body, ValidationPipe, Headers, Ip } from '@nestjs/common';
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
  handleWebhook(@Query() query: Record<string, any>, @Body() body: Record<string, any>, @Headers() headers: Record<string, string>, @Ip() ipAddress: string) {
    const bodyDataId = body?.data?.id as string | undefined;
    const queryDataId = query['data.id'] as string | undefined;
    const queryId = query.id as string | undefined;
    const paymentId = bodyDataId || queryDataId || queryId;

    const bodyType = body?.type as string | undefined;
    const queryType = query.type as string | undefined;
    const queryTopic = query.topic as string | undefined;
    const eventType = bodyType || queryType || queryTopic || 'unknown';

    const bodyKeys = body && typeof body === 'object' ? Object.keys(body) : [];
    const queryKeys = query && typeof query === 'object' ? Object.keys(query) : [];
    const source = bodyDataId ? 'body' : queryDataId || queryId ? 'query' : 'unknown';

    this.logger.log(
      `[Webhook] Entrada resumen: ${JSON.stringify({
        paymentId: paymentId || null,
        eventType,
        source,
        hasBody: bodyKeys.length > 0,
        bodyKeys,
        queryKeys,
      })}`,
    );

    this.logger.log(
      `[Webhook] Headers: ${JSON.stringify({
        'x-request-id': headers['x-request-id'],
        'user-agent': headers['user-agent'],
        'content-type': headers['content-type'],
      })}`,
    );

    if (!paymentId) {
      this.logger.warn('[Webhook] No se encontró paymentId en body/query.');
      return;
    }

    if (eventType === 'payment') {
      this.mercadopagoService.handleWebhook(paymentId, eventType, {
        ipAddress,
        userAgent: headers['user-agent'],
        contentType: headers['content-type'],
        source,
        queryKeys,
        bodyKeys,
      });
      return;
    }

    this.logger.log(`[Webhook] Evento ignorado: ${eventType} (paymentId: ${paymentId}).`);
  }
}
