import { NotFoundException, UseGuards } from '@nestjs/common';
import { Args, Field, ID, InputType, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Repository } from 'typeorm';
import { ActivityService } from '../activity/activity.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { GqlAuthGuard } from '../auth/gql-auth.guard';
import { CollaborationService } from '../collaboration/collaboration.service';
import type { AuthUser } from '../common/gql-context';
import { assertUuid } from '../common/ids';
import { Role } from '../common/roles';
import { WorkspaceEventType } from '../events/workspace-event.model';
import { DocumentSnapshot } from '../persistence/document-snapshot.entity';
import { PersistenceService } from '../persistence/persistence.service';
import { User } from '../users/user.entity';
import { AccessService } from '../workspaces/access.service';

@InputType()
export class CreateDocumentSnapshotInput {
  @Field(() => ID)
  @IsUUID()
  documentId: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label?: string;
}

/** Named versions (restore points) of a document. */
@Resolver(() => DocumentSnapshot)
@UseGuards(GqlAuthGuard)
export class SnapshotsResolver {
  constructor(
    private readonly access: AccessService,
    private readonly persistence: PersistenceService,
    private readonly collaboration: CollaborationService,
    private readonly activity: ActivityService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  @Query(() => [DocumentSnapshot], { description: 'Named versions of a document, newest first.' })
  async documentSnapshots(@CurrentUser() user: AuthUser, @Args('documentId', { type: () => ID }) documentId: string) {
    await this.access.requireDocument(user.id, documentId, Role.VIEWER, { allowArchived: true });
    return this.persistence.listNamedSnapshots(documentId);
  }

  @ResolveField(() => String, { nullable: true })
  async createdByName(@Parent() snapshot: DocumentSnapshot): Promise<string | null> {
    if (!snapshot.createdBy) return null;
    return (await this.users.findOneBy({ id: snapshot.createdBy }))?.name ?? null;
  }

  @Mutation(() => DocumentSnapshot, { description: 'Saves the current content as a named version.' })
  async createDocumentSnapshot(@CurrentUser() user: AuthUser, @Args('input') input: CreateDocumentSnapshotInput) {
    const { document } = await this.access.requireDocument(user.id, input.documentId, Role.EDITOR);
    const label = input.label?.trim() || `Version of ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const snapshot = await this.persistence.createSnapshot(input.documentId, { label, createdBy: user.id });
    await this.activity.record({
      type: WorkspaceEventType.SNAPSHOT_CREATED,
      workspaceId: document.workspaceId,
      actorId: user.id,
      documentId: document.id,
      metadata: { title: document.title, detail: label },
    });
    return snapshot;
  }

  @Mutation(() => DocumentSnapshot, {
    description:
      'Restores a named version as a new edit. The content before the restore is saved first as its own version, so a restore can be undone.',
  })
  async restoreDocumentSnapshot(@CurrentUser() user: AuthUser, @Args('snapshotId', { type: () => ID }) snapshotId: string) {
    const snapshot = await this.persistence.findSnapshot(assertUuid(snapshotId, 'snapshotId'));
    if (!snapshot?.label) throw new NotFoundException('Version not found');
    const { document } = await this.access.requireDocument(user.id, snapshot.documentId, Role.EDITOR);
    const backup = await this.persistence.createSnapshot(document.id, {
      label: `Before restoring "${snapshot.label}"`.slice(0, 200),
      createdBy: user.id,
    });
    await this.collaboration.replaceContent(document.id, new Uint8Array(snapshot.stateData));
    await this.persistence.flush(document.id);
    await this.activity.record({
      type: WorkspaceEventType.SNAPSHOT_RESTORED,
      workspaceId: document.workspaceId,
      actorId: user.id,
      documentId: document.id,
      metadata: { title: document.title, detail: snapshot.label },
    });
    return backup;
  }
}
