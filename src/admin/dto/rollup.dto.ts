import { IsOptional, IsDateString } from 'class-validator';
import { IsDateRangeValid } from './date-range.validator';

export class RollupDto {
  @IsOptional()
  @IsDateString({}, { message: 'date must be a valid ISO date string' })
  date?: string;

  @IsOptional()
  @IsDateString({}, { message: 'from must be a valid ISO date string' })
  from?: string;

  @IsOptional()
  @IsDateString({}, { message: 'to must be a valid ISO date string' })
  @IsDateRangeValid('from', {
    message: 'to must be greater than or equal to from',
  })
  to?: string;
}
