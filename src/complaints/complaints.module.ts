import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../admin/admin.guard';
import { ComplaintsController } from './complaints.controller';
import { ComplaintsService } from './complaints.service';

@Module({
  imports: [AuthModule],
  controllers: [ComplaintsController],
  providers: [ComplaintsService, AdminGuard],
})
export class ComplaintsModule {}
