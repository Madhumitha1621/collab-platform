import { UseGuards } from '@nestjs/common';
import { Args, Field, ID, InputType, Int, Mutation, Parent, Query, ResolveField, Resolver, Subscription } from '@nestjs/graphql';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUser } from '../auth/current-user.decorator';
import { GqlAuthGuard } from '../auth/gql-auth.guard';
import type { AuthUser, GqlContext } from '../common/gql-context';
import { Role } from '../common/roles';
import { EventsService } from '../events/events.service';
import { Workspace } from '../workspaces/workspace.entity';
import { AccessService } from '../workspaces/access.service';
import { Document } from './document.entity';
import { DocumentsService } from './documents.service';

@InputType()
export class CreateDocumentInput {
  @Field(() => ID)
  @IsUUID()
  workspaceId: string;

  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;
}

@InputType()
export class RenameDocumentInput {
  @Field(() => ID)
  @IsUUID()
  id: string;

  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;
}

@Resolver(() => Document)
@UseGuards(GqlAuthGuard)
export class DocumentsResolver {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly access: AccessService,
    private readonly events: EventsService,
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
  ) {}

  @Query(() => [Document])
  documents(
    @CurrentUser() user: AuthUser,
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
    @Args('includeArchived', { type: () => Boolean, defaultValue: false }) includeArchived: boolean,
  ) {
    return this.documentsService.list(user.id, workspaceId, includeArchived);
  }

  @Query(() => [Document], { description: 'Title search across your workspaces (or one workspace); prefix matches first.' })
  searchDocuments(
    @CurrentUser() user: AuthUser,
    @Args('query') query: string,
    @Args('workspaceId', { type: () => ID, nullable: true }) workspaceId?: string,
    @Args('limit', { type: () => Int, defaultValue: 20 }) limit?: number,
  ) {
    return this.documentsService.search(user.id, query, { workspaceId, limit });
  }

  @Query(() => Document)
  document(@CurrentUser() user: AuthUser, @Args('id', { type: () => ID }) id: string) {
    return this.documentsService.get(user.id, id);
  }

  @ResolveField(() => Role)
  async myRole(@Parent() document: Document, @CurrentUser() user: AuthUser) {
    return (await this.access.requireDocument(user.id, document.id, Role.VIEWER, { allowArchived: true })).role;
  }

  @ResolveField(() => String)
  async workspaceName(@Parent() document: Document): Promise<string> {
    return (await this.workspaces.findOneBy({ id: document.workspaceId }))?.name ?? '';
  }

  @Mutation(() => Document)
  createDocument(@CurrentUser() user: AuthUser, @Args('input') input: CreateDocumentInput) {
    return this.documentsService.create(user.id, input.workspaceId, input.title);
  }

  @Mutation(() => Document)
  renameDocument(@CurrentUser() user: AuthUser, @Args('input') input: RenameDocumentInput) {
    return this.documentsService.rename(user.id, input.id, input.title);
  }

  @Mutation(() => Document)
  archiveDocument(@CurrentUser() user: AuthUser, @Args('id', { type: () => ID }) id: string) {
    return this.documentsService.archive(user.id, id);
  }

  @Subscription(() => Document, {
    filter: async function (this: DocumentsResolver, payload, variables, context: GqlContext) {
      const document = await this.access
        .requireDocument(context.user!.id, variables.documentId, Role.VIEWER, { allowArchived: true })
        .catch(() => null);
      return document !== null;
    },
  })
  async documentMetadataChanged(@CurrentUser() user: AuthUser, @Args('documentId', { type: () => ID }) documentId: string) {
    await this.access.requireDocument(user.id, documentId, Role.VIEWER, { allowArchived: true });
    return this.events.pubSub.asyncIterableIterator(EventsService.documentTopic(documentId));
  }
}
