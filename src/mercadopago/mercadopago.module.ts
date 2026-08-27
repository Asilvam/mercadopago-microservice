import { Module } from '@nestjs/common';
import { MercadopagoController } from './mercadopago.controller';
import { MercadopagoService } from './mercadopago.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { InternalApiKeyGuard } from '../common/guards/internal-api-key.guard';

@Module({
  imports: [AuditLogModule],
  controllers: [MercadopagoController], // 1. Registra el controlador
  providers: [MercadopagoService, InternalApiKeyGuard], // 2. Registra el servicio (para inyección)
})
export class MercadopagoModule {}
