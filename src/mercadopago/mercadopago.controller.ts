import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Ip, Logger, Post, Query, UseGuards, ValidationPipe } from '@nestjs/common';
import { MercadopagoService } from './mercadopago.service';
import { CreateMpDto } from './dto/create-mp.dto';
import { InternalApiKeyGuard } from '../common/guards/internal-api-key.guard';

@Controller('mercadopago')
export class MercadopagoController {
  private readonly logger = new Logger(MercadopagoController.name);
  constructor(private readonly mercadopagoService: MercadopagoService) {}

  @Post('create-preference')
  @UseGuards(InternalApiKeyGuard)
  createPaymentPreference(@Body(new ValidationPipe()) paymentDTO: CreateMpDto) {
    return this.mercadopagoService.createPaymentPreference(paymentDTO);
  }

  @Get('health')
  getReliabilityHealth() {
    const metrics = this.mercadopagoService.getReliabilityMetrics();
    return {
      status: metrics.audit.connected ? 'ok' : 'degraded',
      metrics,
    };
  }

  @Post('webhook') // Mercado Pago usa POST aunque los datos estén en la URL
  @HttpCode(200) // Responde 200 solo después de persistir la entrada del inbox
  async handleWebhook(
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Ip() ipAddress: string,
  ) {
    const bodyData = body?.data as Record<string, unknown> | undefined;
    const bodyDataId = bodyData?.id as string | undefined;
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
      throw new BadRequestException('paymentId is required');
    }

    if (eventType === 'payment') {
      return this.mercadopagoService.acceptWebhook({
        paymentId,
        eventType,
        requestId: this.headerValue(headers['x-request-id']),
        dataId: queryDataId || queryId || bodyDataId,
        xSignature: headers['x-signature'],
        metadata: {
          ipAddress,
          userAgent: this.headerValue(headers['user-agent']),
          contentType: this.headerValue(headers['content-type']),
          source,
          queryKeys,
          bodyKeys,
        },
        payload: { body, query },
      });
    }

    this.logger.log(`[Webhook] Evento ignorado: ${eventType} (paymentId: ${paymentId}).`);
    return { accepted: true, ignored: true };
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
