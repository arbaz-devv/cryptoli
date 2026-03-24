import { IsOptional, IsString, IsDateString, MaxLength } from 'class-validator';
import { PageLimitDto } from './page-limit.dto';
import { IsDateRangeValid } from './date-range.validator';

export class ComplaintsQueryDto extends PageLimitDto {
  @IsOptional()
  @IsString({ message: 'q must be a string' })
  @MaxLength(200, { message: 'q must not exceed 200 characters' })
  q?: string;

  @IsOptional()
  @IsString({ message: 'status must be a string' })
  status?: string;

  @IsOptional()
  @IsDateString(
    {},
    { message: 'dateFrom must be a valid ISO 8601 date string' },
  )
  dateFrom?: string;

  @IsOptional()
  @IsDateString({}, { message: 'dateTo must be a valid ISO 8601 date string' })
  @IsDateRangeValid('dateFrom', {
    message: 'dateTo must be greater than or equal to dateFrom',
  })
  dateTo?: string;
}
