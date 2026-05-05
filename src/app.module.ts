import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MercadopagoModule } from './mercadopago/mercadopago.module';
import { MongooseModule } from '@nestjs/mongoose';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // Para las variables .env
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'),
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        retryAttempts: 0,
        retryDelay: 1000,
      }),
    }),
    MercadopagoModule, // <-- 2. Añadir a los imports
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
