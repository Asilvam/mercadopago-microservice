import { Module } from '@nestjs/common';
import { MercadopagoController } from './mercadopago.controller';
import { MercadopagoService } from './mercadopago.service';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [MercadopagoController], // 1. Registra el controlador
  providers: [MercadopagoService], // 2. Registra el servicio (para inyección)
})
export class MercadopagoModule {}
