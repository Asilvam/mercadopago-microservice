import { IsString, IsNumber, IsNotEmpty, IsOptional, IsDateString } from 'class-validator';

export class CreateMpDto {
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsString()
  @IsNotEmpty()
  courtId: string;

  @IsString()
  @IsNotEmpty()
  date: string;

  @IsString()
  @IsNotEmpty()
  time: string;

  @IsString()
  @IsNotEmpty()
  player1: string;

  @IsNumber()
  @IsNotEmpty()
  amount: number;

  @IsString()
  @IsNotEmpty()
  idCourtReserve: string;
}
