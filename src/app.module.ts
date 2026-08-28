import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MercadopagoModule } from './mercadopago/mercadopago.module';
import { MongooseModule } from '@nestjs/mongoose';
import * as Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        MP_ACCESS_TOKEN: Joi.string().required(),
        MP_WEBHOOK_SECRET: Joi.string().required(),
        BACKEND_URL: Joi.string().uri().required(),
        INTERNAL_API_KEY: Joi.string().min(16).required(),
        MONGODB_URI: Joi.string().required(),
        MP_SUCCESS_URL: Joi.string().uri().required(),
        MP_FAILURE_URL: Joi.string().uri().required(),
        MP_PENDING_URL: Joi.string().uri().required(),
        NOTIFICATION_URL: Joi.string().uri().required(),
        PORT: Joi.number().default(3000),
        WEBHOOK_POLL_INTERVAL_MS: Joi.number().default(5000),
        WEBHOOK_MAX_ATTEMPTS: Joi.number().default(6),
        WEBHOOK_LOCK_TIMEOUT_MS: Joi.number().default(120000),
        WEBHOOK_RETRY_BASE_MS: Joi.number().default(5000),
        WEBHOOK_RETRY_MAX_MS: Joi.number().default(900000),
        AUDIT_LOG_RETENTION_DAYS: Joi.number().default(365),
        WEBHOOK_INBOX_RETENTION_DAYS: Joi.number().default(30),
        WEBHOOK_EFFECT_RETENTION_DAYS: Joi.number().default(365),
        MP_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS: Joi.number().default(300),
        FRONTEND_URL: Joi.string().uri().optional(),
      }),
      validationOptions: {
        allowUnknown: true,
        abortEarly: false,
      },
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'),
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        retryAttempts: Infinity,
        retryDelay: 5000,
      }),
    }),
    MercadopagoModule, // <-- 2. Añadir a los imports
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
