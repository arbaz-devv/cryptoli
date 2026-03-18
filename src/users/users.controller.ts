import {
  Controller,
  Get,
  Param,
  Post,
  Delete,
  Req,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import type { SessionUser } from '../auth/auth.service';
import { UsersService } from './users.service';

@Controller('api/users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('follow-status-bulk')
  @UseGuards(OptionalAuthGuard)
  async getFollowStatusBulk(
    @Query('usernames') usernames: string,
    @Req() req?: Request & { user?: SessionUser | null },
  ) {
    const viewerId = req?.user?.id ?? null;
    const list = usernames
      ? usernames
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    return this.usersService.getFollowStatusBulk(viewerId, list);
  }

  @Get(':username/follow-status')
  @UseGuards(OptionalAuthGuard)
  async getFollowStatus(
    @Param('username') username: string,
    @Req() req?: Request & { user?: SessionUser | null },
  ) {
    const viewerId = req?.user?.id ?? null;
    return this.usersService.getFollowStatus(viewerId, username);
  }

  @Get(':username')
  @UseGuards(OptionalAuthGuard)
  async getProfile(
    @Param('username') username: string,
    @Req() req?: Request & { user?: SessionUser | null },
  ) {
    const viewerId = req?.user?.id ?? null;
    return this.usersService.getPublicProfile(viewerId, username);
  }

  @Post(':username/follow')
  @UseGuards(AuthGuard)
  async follow(
    @Param('username') username: string,
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.usersService.followUser(req.user.id, username);
  }

  @Delete(':username/follow')
  @UseGuards(AuthGuard)
  async unfollow(
    @Param('username') username: string,
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.usersService.unfollowUser(req.user.id, username);
  }

  @Get(':username/followers')
  async followers(@Param('username') username: string) {
    return this.usersService.listFollowers(username);
  }

  @Get(':username/following')
  async following(@Param('username') username: string) {
    return this.usersService.listFollowing(username);
  }
}
