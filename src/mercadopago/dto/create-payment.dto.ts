// src/mercadopago/dto/create-payment.dto.ts

import { IsEmail, IsNumber, IsString, IsNotEmpty, IsPositive } from 'class-validator';

export class CreatePaymentDTO {
  /**
   * Identificador interno del item.
   * @example "cuota-socio-001"
   */
  @IsString()
  @IsNotEmpty()
  itemId: string;

  /**
   * Título que verá el usuario en la pasarela de pago.
   * @example "Cuota Socio Enero - Club de Tenis Quintero"
   */
  @IsString()
  @IsNotEmpty()
  title: string;

  /**
   * Descripción del item.
   * @example "Pago cuota mensual socio Álvaro."
   */
  @IsString()
  @IsNotEmpty()
  description: string;

  /**
   * Precio unitario del item. Debe ser un número positivo.
   * @example 25000
   */
  @IsNumber()
  @IsPositive()
  unit_price: number;

  /**
   * Moneda del item.
   * @example "CLP"
   */
  @IsString()
  @IsNotEmpty()
  currency_id: string; // Ej: 'CLP'

  /**
   * Email del socio que está realizando el pago.
   * @example "socio@email.com"
   */
  @IsEmail()
  @IsNotEmpty()
  payerEmail: string;

  @IsString()
  @IsNotEmpty()
  payerFirstName: string;

  @IsString()
  @IsNotEmpty()
  payerLastName: string;

  @IsString()
  @IsNotEmpty()
  payerIdentificationType: string; // Ej: "RUT", "DNI", "CPF"

  @IsString()
  @IsNotEmpty()
  payerIdentificationNumber: string; // Ej: "12345678-9"
}
