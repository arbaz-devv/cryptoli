import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import type { SessionUser } from '../auth/auth.service';
import { PostsService } from './posts.service';

const POSTS_LIST_LIMIT_MAX = 50;

@Controller('api/posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  list(@Query('page') page = '1', @Query('limit') limit = '20') {
    const parsedPage = parseInt(page, 10) || 1;
    const parsedLimit = parseInt(limit, 10) || 20;
    const safePage = Math.max(1, parsedPage);
    const safeLimit = Math.min(
      POSTS_LIST_LIMIT_MAX,
      Math.max(1, parsedLimit),
    );

    return this.postsService.list(safePage, safeLimit);
  }

  @Post()
  @UseGuards(AuthGuard)
  create(
    @Body() body: unknown,
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.postsService.create(req.user.id, body);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.postsService.getById(id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  remove(
    @Param('id') id: string,
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.postsService.remove(req.user.id, id);
  }
}
