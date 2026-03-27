import { IsEnum } from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';

export enum ExportFormat {
  CSV = 'csv',
  JSON = 'json',
}

export class SessionsExportQueryDto {
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.toLowerCase().trim() : (value as unknown),
  )
  @IsEnum(ExportFormat, {
    message: 'format must be one of: csv, json',
  })
  format: ExportFormat;
}
