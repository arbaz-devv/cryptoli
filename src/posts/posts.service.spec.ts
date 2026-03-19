import { PostsService } from './posts.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { createPrismaMock } from '../../test/helpers/prisma.mock';

describe('PostsService', () => {
  let service: PostsService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new PostsService(prisma as unknown as PrismaService);
  });

  describe('list()', () => {
    it('should return paginated posts', async () => {
      prisma.post.findMany.mockResolvedValue([
        { id: 'p1', content: 'Hello', author: { id: 'u1', username: 'user1' } },
      ]);
      prisma.post.count.mockResolvedValue(1);

      const result = await service.list(1, 10);

      expect(result.posts).toHaveLength(1);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 1,
        totalPages: 1,
      });
    });

    it('should paginate correctly', async () => {
      prisma.post.findMany.mockResolvedValue([]);
      prisma.post.count.mockResolvedValue(25);

      const result = await service.list(2, 10);

      expect(result.pagination.totalPages).toBe(3);
      const findCall = prisma.post.findMany.mock.calls[0][0];
      expect(findCall.skip).toBe(10);
      expect(findCall.take).toBe(10);
    });
  });

  describe('create()', () => {
    it('should create a post with valid content', async () => {
      prisma.post.create.mockResolvedValue({
        id: 'p1',
        content: 'My first post',
        authorId: 'u1',
        author: { id: 'u1', username: 'user1' },
      });

      const result = await service.create('u1', { content: 'My first post' });

      expect(result.id).toBe('p1');
      expect(result.content).toBe('My first post');
      expect(prisma.post.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { content: 'My first post', authorId: 'u1' },
        }),
      );
    });

    it('should reject empty content', async () => {
      await expect(service.create('u1', { content: '' })).rejects.toThrow();
    });

    it('should reject missing content', async () => {
      await expect(service.create('u1', {})).rejects.toThrow();
    });
  });

  describe('getById()', () => {
    it('should return a post with comments', async () => {
      prisma.post.findUnique.mockResolvedValue({
        id: 'p1',
        content: 'Hello',
        author: { id: 'u1', username: 'user1' },
        comments: [],
        _count: { comments: 0, reactions: 0 },
      });

      const result = await service.getById('p1');

      expect(result.id).toBe('p1');
    });

    it('should throw NotFoundError for missing post', async () => {
      prisma.post.findUnique.mockResolvedValue(null);

      await expect(service.getById('missing')).rejects.toThrow(NotFoundError);
    });
  });

  describe('remove()', () => {
    it('should delete own post', async () => {
      prisma.post.findUnique.mockResolvedValue({
        id: 'p1',
        authorId: 'u1',
      });
      prisma.post.delete.mockResolvedValue({});

      const result = await service.remove('u1', 'p1');

      expect(result).toEqual({ deleted: true });
      expect(prisma.post.delete).toHaveBeenCalledWith({
        where: { id: 'p1' },
      });
    });

    it('should throw NotFoundError for non-existent post', async () => {
      prisma.post.findUnique.mockResolvedValue(null);

      await expect(service.remove('u1', 'missing')).rejects.toThrow(
        NotFoundError,
      );
    });

    it('should throw NotFoundError when trying to delete another users post', async () => {
      prisma.post.findUnique.mockResolvedValue({
        id: 'p1',
        authorId: 'other-user',
      });

      await expect(service.remove('u1', 'p1')).rejects.toThrow(NotFoundError);
    });
  });
});
