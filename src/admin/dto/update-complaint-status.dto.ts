import { IsIn } from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';

const COMPLAINT_STATUSES = ['open', 'in_progress', 'resolved', 'dismissed'];

export class UpdateComplaintStatusDto {
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim().toLowerCase() : (value as unknown),
  )
  @IsIn(COMPLAINT_STATUSES, {
    message: 'status must be one of: open, in_progress, resolved, dismissed',
  })
  status: string;
}
