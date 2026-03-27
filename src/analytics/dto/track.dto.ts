import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class TrackDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  device?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsIn([
    'page_view',
    'page_leave',
    'signup_started',
    'signup_completed',
    'purchase',
    'like',
  ])
  event?:
    | 'page_view'
    | 'page_leave'
    | 'signup_started'
    | 'signup_completed'
    | 'purchase'
    | 'like';

  @IsOptional()
  @IsUUID(4)
  sessionId?: string;

  @IsOptional()
  @IsISO8601()
  enteredAt?: string;

  @IsOptional()
  @IsISO8601()
  leftAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  referrer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  utm_source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  utm_medium?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  utm_campaign?: string;

  /** When true, event is from a user who accepted analytics cookies; when false, do not store. */
  @IsOptional()
  @IsBoolean()
  consent?: boolean;
}
