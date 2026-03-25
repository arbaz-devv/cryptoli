import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';

const USER_STATUSES = ['active', 'suspended'];

export class UpdateUserStatusDto {
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : (value as unknown),
  )
  @IsIn(USER_STATUSES, {
    message: 'status must be one of: active, suspended',
  })
  status: string;

  @IsOptional()
  @IsString({ message: 'reason must be a string' })
  @MaxLength(500, { message: 'reason must not exceed 500 characters' })
  reason?: string;
}
