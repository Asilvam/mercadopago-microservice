// src/mercadopago/mercadopago.module.ts

import { Module } from '@nestjs/common';
import { MercadopagoController } from './mercadopago.controller';
import { MercadopagoService } from './mercadopago.service';

@Module({
  imports: [],
  controllers: [MercadopagoController], // 1. Registra el controlador
  providers: [MercadopagoService], // 2. Registra el servicio (para inyección)
})
export class MercadopagoModule {}
