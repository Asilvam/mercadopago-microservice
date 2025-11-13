import { IsNumber, IsString, IsNotEmpty, IsPositive } from 'class-validator';

export class CreatePaymentDTO {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsNumber()
  @IsPositive()
  unit_price: number;

  @IsString()
  @IsNotEmpty()
  currency_id: string;
}
