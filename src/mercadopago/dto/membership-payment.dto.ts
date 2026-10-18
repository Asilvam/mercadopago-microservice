import { Equals, IsDateString, IsIn, IsInt, IsString, Matches, Min } from 'class-validator';

export class CreateMembershipPreferenceDto {
  @Equals('MEMBERSHIP') purpose: string;
  @Matches(/^membership-[a-f\d-]{36}$/i) reference: string;
  @IsInt() @Min(1) amount: number;
  @IsIn(['TEST', 'STANDARD']) pricingMode: string;
  @IsDateString() expiresAt: string;
}

export class ReconcileMembershipDto {
  @IsString() @Matches(/^membership-[a-f\d-]{36}$/i) reference: string;
}
