import { Controller, Post, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto';

@Controller('api/admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Throttle({
    short: { limit: 5, ttl: 60_000 },
    long: { limit: 5, ttl: 60_000 },
  })
  @Post('login')
  async login(@Body() dto: AdminLoginDto) {
    return this.adminAuth.login(dto.email, dto.password);
  }

  @Post('config')
  config() {
    return { loginEnabled: this.adminAuth.isLoginEnabled() };
  }
}
