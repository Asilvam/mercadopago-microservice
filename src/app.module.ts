import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { MercadopagoModule } from './mercadopago/mercadopago.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // Para las variables .env
    }),
    MercadopagoModule, // <-- 2. Añadir a los imports
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
