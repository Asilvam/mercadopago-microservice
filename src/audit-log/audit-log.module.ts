import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditLogService } from './audit-log.service';
import { AuditLogSchema } from './audit-log.entity';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'AuditLog', schema: AuditLogSchema },
    ]),
  ],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
