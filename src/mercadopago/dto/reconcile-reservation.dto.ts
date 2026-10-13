import { IsNotEmpty, IsString } from 'class-validator';

export class ReconcileReservationDto {
  @IsString()
  @IsNotEmpty()
  reservationId: string;
}
