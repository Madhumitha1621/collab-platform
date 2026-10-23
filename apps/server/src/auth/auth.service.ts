import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { IsNull, MoreThan, Repository } from 'typeorm';
import type { AuthUser } from '../common/gql-context';
import { appConfig } from '../config';
import { EventsService } from '../events/events.service';
import { User } from '../users/user.entity';
import { Session } from './session.entity';

interface TokenClaims {
  sub: string;
  sid: string;
}

const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Session) private readonly sessions: Repository<Session>,
    private readonly jwt: JwtService,
    private readonly events: EventsService,
  ) {}

  async register(name: string, email: string, password: string) {
    const normalized = email.trim().toLowerCase();
    if (await this.users.exist({ where: { email: normalized } })) {
      throw new BadRequestException('An account with this email already exists');
    }
    const user = await this.users.save(
      this.users.create({ name: name.trim(), email: normalized, passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) }),
    );
    return { user, token: await this.issueToken(user) };
  }

  async login(email: string, password: string) {
    const user = await this.users.findOne({ where: { email: email.trim().toLowerCase() } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return { user, token: await this.issueToken(user) };
  }

  async logout(sessionId: string) {
    await this.sessions.update({ id: sessionId }, { revokedAt: new Date() });
    this.events.emitAccess({ type: 'session-revoked', sessionId });
  }

  /** Validates a bearer token for GraphQL, subscriptions and collaboration connections alike. */
  async validateToken(token: string | undefined | null): Promise<AuthUser> {
    if (!token) throw new UnauthorizedException('Missing credentials');
    let claims: TokenClaims;
    try {
      claims = await this.jwt.verifyAsync<TokenClaims>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const session = await this.sessions.findOne({
      where: { id: claims.sid, userId: claims.sub, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
    });
    if (!session) throw new UnauthorizedException('Session expired or revoked');
    const user = await this.users.findOne({ where: { id: claims.sub } });
    if (!user) throw new UnauthorizedException('Unknown user');
    return { id: user.id, name: user.name, email: user.email, sessionId: session.id };
  }

  private async issueToken(user: User): Promise<string> {
    const ttl = appConfig().jwtExpiresInSeconds;
    const session = await this.sessions.save(
      this.sessions.create({ userId: user.id, expiresAt: new Date(Date.now() + ttl * 1000) }),
    );
    this.logger.log(`session created user=${user.id} session=${session.id}`);
    return this.jwt.signAsync({ sub: user.id, sid: session.id } satisfies TokenClaims, { expiresIn: ttl });
  }
}
