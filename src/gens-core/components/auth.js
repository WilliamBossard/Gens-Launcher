const crypto = require('crypto');

const CLIENT_ID = '00000000441cc96b'; // Nintendo Switch Microsoft App ID

class MicrosoftAuth {
    constructor() {
        this.cancelled = false;
    }

    cancel() {
        this.cancelled = true;
    }

    async getDeviceCode() {
        const res = await fetch('https://login.live.com/oauth20_connect.srf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                scope: 'service::user.auth.xboxlive.com::MBI_SSL',
                response_type: 'device_code'
            })
        });
        if (!res.ok) throw new Error("Failed to get device code: " + res.status);
        const data = await res.json();
        return {
            user_code: data.user_code,
            device_code: data.device_code,
            verification_uri: data.verification_uri,
            interval: data.interval,
            expires_in: data.expires_in,
            message: `Please go to ${data.verification_uri} and enter code ${data.user_code}`
        };
    }

    async pollDeviceCode(deviceCode, interval) {
        return new Promise((resolve, reject) => {
            const poll = async () => {
                if (this.cancelled) return reject(new URIError("Microsoft login cancelled"));
                try {
                    const res = await fetch('https://login.live.com/oauth20_token.srf', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({
                            client_id: CLIENT_ID,
                            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                            device_code: deviceCode
                        })
                    });
                    const data = await res.json();
                    if (data.error === 'authorization_pending') {
                        setTimeout(poll, interval * 1000);
                    } else if (data.access_token) {
                        resolve(data);
                    } else {
                        reject(new Error("Polling failed: " + JSON.stringify(data)));
                    }
                } catch (e) {
                    reject(e);
                }
            };
            poll();
        });
    }

    async refreshMsaToken(refreshToken) {
        const res = await fetch('https://login.live.com/oauth20_token.srf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                scope: 'service::user.auth.xboxlive.com::MBI_SSL',
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            })
        });
        if (!res.ok) {
            const errTxt = await res.text();
            throw new Error(`Failed to refresh MSA token: ${res.status} ${errTxt}`);
        }
        return await res.json();
    }

    async getXboxLiveToken(msaAccessToken) {
        if (this.cancelled) throw new URIError("Microsoft login cancelled");
        const res = await fetch('https://user.auth.xboxlive.com/user/authenticate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-xbl-contract-version': '1'
            },
            body: JSON.stringify({
                Properties: {
                    AuthMethod: "RPS",
                    SiteName: "user.auth.xboxlive.com",
                    RpsTicket: msaAccessToken.startsWith('t=') || msaAccessToken.startsWith('d=') ? msaAccessToken : `t=${msaAccessToken}`
                },
                RelyingParty: "http://auth.xboxlive.com",
                TokenType: "JWT"
            })
        });
        if (!res.ok) throw new Error("Failed to authenticate Xbox Live: " + res.status);
        return await res.json();
    }

    async getXstsToken(xblToken) {
        if (this.cancelled) throw new URIError("Microsoft login cancelled");
        const res = await fetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-xbl-contract-version': '1'
            },
            body: JSON.stringify({
                Properties: {
                    SandboxId: "RETAIL",
                    UserTokens: [xblToken]
                },
                RelyingParty: "rp://api.minecraftservices.com/",
                TokenType: "JWT"
            })
        });
        if (res.status === 401) {
            const err = await res.json();
            if (err.XErr === 2148916233) throw new Error("Le compte Microsoft ne possède pas de compte Xbox Live.");
            if (err.XErr === 2148916235) throw new Error("Le compte Xbox Live est bloqué dans une région où il n'est pas disponible.");
            if (err.XErr === 2148916238) throw new Error("Le compte est un compte enfant. Vous devez l'ajouter à une famille.");
        }
        if (!res.ok) throw new Error("Failed to authenticate XSTS: " + res.status);
        return await res.json();
    }

    async getMinecraftToken(userHash, xstsToken) {
        if (this.cancelled) throw new URIError("Microsoft login cancelled");
        const res = await fetch('https://api.minecraftservices.com/authentication/login_with_xbox', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                identityToken: `XBL3.0 x=${userHash};${xstsToken}`
            })
        });
        if (!res.ok) throw new Error("Failed to authenticate Minecraft: " + res.status);
        return await res.json();
    }

    async getMinecraftProfile(mcAccessToken) {
        if (this.cancelled) throw new URIError("Microsoft login cancelled");
        const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
            headers: {
                'Authorization': `Bearer ${mcAccessToken}`
            }
        });
        if (!res.ok) throw new Error("Failed to get Minecraft profile (Vous ne possédez peut-être pas le jeu).");
        return await res.json();
    }

    async flowDeviceCode(onCode) {
        const devCodeInfo = await this.getDeviceCode();
        onCode(devCodeInfo);
        const tokenRes = await this.pollDeviceCode(devCodeInfo.device_code, devCodeInfo.interval);
        return this.exchangeTokens(tokenRes.access_token, tokenRes.refresh_token);
    }

    async flowRefresh(refreshToken) {
        const tokenRes = await this.refreshMsaToken(refreshToken);
        return this.exchangeTokens(tokenRes.access_token, tokenRes.refresh_token);
    }

    async exchangeTokens(msaAccessToken, newRefreshToken = null) {
        const xblRes = await this.getXboxLiveToken(msaAccessToken);
        const xblToken = xblRes.Token;

        const xstsRes = await this.getXstsToken(xblToken);
        const xstsToken = xstsRes.Token;
        const userHash = xstsRes.DisplayClaims.xui[0].uhs;

        const mcRes = await this.getMinecraftToken(userHash, xstsToken);
        const mcAccessToken = mcRes.access_token;

        const profile = await this.getMinecraftProfile(mcAccessToken);

        return {
            mcToken: mcAccessToken,
            profile: profile,
            msaRefreshToken: newRefreshToken // Might be passed if we did a flowRefresh
        };
    }
}

module.exports = MicrosoftAuth;
