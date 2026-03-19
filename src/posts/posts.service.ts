import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { createPostSchema } from '../common/utils';

@Injectable()
export class PostsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(page: number, limit: number) {
    const [posts, total] = await Promise.all([
      this.prisma.post.findMany({
        include: {
          author: {
            select: {
              id: true,
              username: true,
              avatar: true,
              verified: true,
            },
          },
          _count: {
            select: {
              comments: true,
              reactions: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.post.count(),
    ]);

    return {
      posts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async create(authorId: string, body: unknown) {
    const data = createPostSchema.parse(body);

    const post = await this.prisma.post.create({
      data: {
        content: data.content,
        authorId,
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            avatar: true,
            verified: true,
          },
        },
        _count: {
          select: {
            comments: true,
            reactions: true,
          },
        },
      },
    });

    return post;
  }

  async getById(id: string) {
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            avatar: true,
            verified: true,
          },
        },
        comments: {
          include: {
            author: {
              select: {
                id: true,
                username: true,
                avatar: true,
                verified: true,
              },
            },
            _count: {
              select: {
                reactions: true,
                votes: true,
                replies: true,
              },
            },
          },
          where: { parentId: null },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        _count: {
          select: {
            comments: true,
            reactions: true,
          },
        },
      },
    });

    if (!post) {
      throw new NotFoundError('Post not found');
    }

    return post;
  }

  async remove(authorId: string, postId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true, authorId: true },
    });

    if (!post) {
      throw new NotFoundError('Post not found');
    }

    if (post.authorId !== authorId) {
      throw new NotFoundError('Post not found');
    }

    await this.prisma.post.delete({ where: { id: postId } });
    return { deleted: true };
  }
}
