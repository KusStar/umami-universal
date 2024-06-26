import ipaddr from 'ipaddr.js';
import { isbot } from 'isbot';
import { COLLECTION_TYPE, HOSTNAME_REGEX, IP_REGEX } from 'lib/constants';
import { secret } from 'lib/crypto';
import { getIpAddress } from 'lib/detect';
import { useCors, useSession, useValidate } from 'lib/middleware';
import { CollectionType, YupRequest } from 'lib/types';
import { NextApiRequest, NextApiResponse } from 'next';
import { badRequest, createToken, forbidden, methodNotAllowed, ok, send } from 'next-basics';
import { saveEvent, saveSessionData } from 'queries';
import * as yup from 'yup';

export interface CollectRequestBody {
  payload: {
    data: { [key: string]: any };
    hostname?: string;
    ip: string;
    language: string;
    referrer: string;
    screen?: string;
    title: string;
    url?: string;
    website: string;
    name: string;
    app?: string;
    os?: string;
    page?: string;
    device?: string;
  };
  type: CollectionType;
}

export interface NextApiRequestCollect extends NextApiRequest {
  body: CollectRequestBody;
  session: {
    id: string;
    websiteId: string;
    ownerId: string;
    hostname: string;
    browser: string;
    os: string;
    device: string;
    screen?: string;
    language: string;
    country: string;
    subdivision1: string;
    subdivision2: string;
    city: string;
  };
  headers: { [key: string]: any };
  yup: YupRequest;
}

const schema = {
  POST: yup.object().shape({
    payload: yup
      .object()
      .shape({
        data: yup.object().optional(),
        hostname: yup.string().matches(HOSTNAME_REGEX).max(100).optional(),
        ip: yup.string().matches(IP_REGEX),
        language: yup.string().max(35).optional(),
        referrer: yup.string().optional(),
        screen: yup.string().max(11).optional(),
        title: yup.string().optional(),
        url: yup.string().optional(),
        website: yup.string().required(),
        name: yup.string().max(50).optional(),
        app: yup.string().optional(),
        os: yup.string().optional(),
        page: yup.string().optional(),
        device: yup.string().optional(),
      })
      .required(),
    type: yup
      .string()
      .matches(/event|identify/i)
      .required(),
  }),
};

export default async (req: NextApiRequestCollect, res: NextApiResponse) => {
  await useCors(req, res);

  const { type, payload } = req.body;

  const isApp = Boolean(payload?.app || payload?.os);

  if (req.method === 'POST') {
    if (!process.env.DISABLE_BOT_CHECK && isbot(req.headers['user-agent']) && !isApp) {
      return ok(res);
    }

    await useValidate(schema, req, res);

    if (hasBlockedIp(req)) {
      return forbidden(res);
    }

    const { url, page, referrer, name: eventName, data: eventData, title: pageTitle } = payload;

    await useSession(req, res);

    const session = req.session;

    if (type === COLLECTION_TYPE.event) {
      // eslint-disable-next-line prefer-const
      let [urlPath, urlQuery] = (page || url)?.split('?') || [];
      let [referrerPath, referrerQuery] = referrer?.split('?') || [];
      let referrerDomain;

      if (!urlPath) {
        urlPath = '/';
      }

      if (referrerPath?.startsWith('http')) {
        const refUrl = new URL(referrer);
        referrerPath = refUrl.pathname;
        referrerQuery = refUrl.search.substring(1);
        referrerDomain = refUrl.hostname.replace(/www\./, '');
      }

      if (process.env.REMOVE_TRAILING_SLASH) {
        urlPath = urlPath.replace(/.+\/$/, '');
      }

      await saveEvent({
        urlPath,
        urlQuery,
        referrerPath,
        referrerQuery,
        referrerDomain,
        pageTitle,
        eventName,
        eventData,
        ...session,
        sessionId: session.id,
      });
    }

    if (type === COLLECTION_TYPE.identify) {
      if (!eventData) {
        return badRequest(res, 'Data required.');
      }

      await saveSessionData({
        websiteId: session.websiteId,
        sessionId: session.id,
        sessionData: eventData,
      });
    }

    const token = createToken(session, secret());

    return send(res, token);
  }

  return methodNotAllowed(res);
};

function hasBlockedIp(req: NextApiRequestCollect) {
  const ignoreIps = process.env.IGNORE_IP;

  if (ignoreIps) {
    const ips = [];

    if (ignoreIps) {
      ips.push(...ignoreIps.split(',').map(n => n.trim()));
    }

    const clientIp = getIpAddress(req);

    return ips.find(ip => {
      if (ip === clientIp) return true;

      // CIDR notation
      if (ip.indexOf('/') > 0) {
        const addr = ipaddr.parse(clientIp);
        const range = ipaddr.parseCIDR(ip);

        if (addr.kind() === range[0].kind() && addr.match(range)) return true;
      }
    });
  }

  return false;
}
