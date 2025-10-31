// src/mercadopago/dto/webhook-data.dto.ts
import { Type } from 'class-transformer';
import { IsString, IsDefined, ValidateNested } from 'class-validator';

// DTO anidado para el objeto "data"
class WebhookData {
  @IsString()
  @IsDefined()
  id: string; // Este es el Payment ID
}

// DTO principal del Webhook
export class WebhookDTO {
  @IsString()
  action: string; // Ej: "payment.updated"

  @ValidateNested()
  @Type(() => WebhookData)
  @IsDefined()
  data: WebhookData;
}
