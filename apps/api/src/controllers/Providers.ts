import {Controller, Delete, Get, Middleware, Post} from '@overnightjs/core';
import {EmailProviderType} from '@plunk/db';
import type {Request, Response} from 'express';

import {HttpException} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {MembershipService} from '../services/MembershipService.js';
import {ProviderConfigService} from '../services/ProviderConfigService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

function requireProjectId(projectId: string | undefined): string {
  if (!projectId) {
    throw new HttpException(400, 'Project ID is required');
  }
  return projectId;
}

@Controller('projects/:projectId/providers')
export class Providers {
  /**
   * List all email provider configs for a project
   * GET /projects/:projectId/providers
   */
  @Get('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async list(req: Request, res: Response) {
    const auth = res.locals.auth;
    const projectId = requireProjectId(req.params.projectId);

    await MembershipService.requireAccess(auth.userId!, projectId);

    const providers = await ProviderConfigService.list(projectId);

    return res.json({success: true, providers});
  }

  /**
   * Create or update an email provider config for a project
   * POST /projects/:projectId/providers
   */
  @Post('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async upsert(req: Request, res: Response) {
    const auth = res.locals.auth;
    const projectId = requireProjectId(req.params.projectId);

    // Reordering/enabling providers and setting API keys requires admin access
    await MembershipService.requireAdminAccess(auth.userId!, projectId);

    const {provider, enabled, priority, apiKey, dailyQuota, monthlyQuota} = req.body;
    const result = await ProviderConfigService.upsert(projectId, {
      provider: provider as EmailProviderType,
      enabled,
      priority,
      apiKey,
      dailyQuota,
      monthlyQuota,
    });

    return res.json({success: true, provider: result});
  }

  /**
   * Remove an email provider config from a project
   * DELETE /projects/:projectId/providers/:provider
   */
  @Delete(':provider')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async remove(req: Request, res: Response) {
    const auth = res.locals.auth;
    const projectId = requireProjectId(req.params.projectId);

    await MembershipService.requireAdminAccess(auth.userId!, projectId);

    await ProviderConfigService.remove(projectId, req.params.provider as EmailProviderType);

    return res.json({success: true});
  }
}
