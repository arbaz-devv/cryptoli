import {
  Controller,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import type { SessionUser } from '../auth/auth.service';
import { ReactionsService } from './reactions.service';

@Controller('api/reactions')
@UseGuards(AuthGuard)
export class ReactionsController {
  constructor(private readonly reactionsService: ReactionsService) {}

  @Post()
  toggle(
    @Body() body: unknown,
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.reactionsService.toggle(req.user.id, body);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.reactionsService.remove(req.user.id, id);
  }
}
