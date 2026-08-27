import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditLogService } from './audit-log.service';
import { AuditLogSchema } from './audit-log.entity';
import { WebhookEffect, WebhookEffectSchema, WebhookInbox, WebhookInboxSchema } from './webhook-inbox.entity';
import { WebhookInboxService } from './webhook-inbox.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'AuditLog', schema: AuditLogSchema },
      { name: WebhookInbox.name, schema: WebhookInboxSchema },
      { name: WebhookEffect.name, schema: WebhookEffectSchema },
    ]),
  ],
  providers: [AuditLogService, WebhookInboxService],
  exports: [AuditLogService, WebhookInboxService],
})
export class AuditLogModule {}
