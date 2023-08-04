import {CBOR} from "cbor-redux";
import * as asn1js from "asn1js";
import { utils } from "ethers";

function toU32(buf:Uint8Array) {
    return (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
}

function toU16(buf:Uint8Array) {
    return (buf[0] << 8) | buf[1];
}

/** @typedef {}
 */
interface RawCOSEPublicKey {
    '1': number,
    '3': number,
    '-1': number,
    '-2': Uint8Array,
    '-3': Uint8Array|undefined
}

interface COSEPublicKey_EC {
    kty: number,
    alg: number,
    crv: number,
    x: Uint8Array,
    y: Uint8Array
}

type COSEPublicKey = COSEPublicKey_EC;

/**
 * Decode a COSE public key into dict (Containing: kty, alg, crv, etc.)
 */
function COSEPublicKey_decode (buf:ArrayBufferLike) : COSEPublicKey
{
    const cpk = CBOR.decode<RawCOSEPublicKey>(buf);

    const kty = cpk[1];

    // Elliptic Curve key type
    if( kty == 2 ) {
        const ret = {
            kty,
            alg: cpk[3],
            crv: cpk[-1],
            x: cpk[-2],
            /** @type {Uint8Array} */
            y: cpk[-3]
        } as COSEPublicKey_EC;

        // Restrict to specific supported algorithms
        if( ! (ret.alg == -7 && ret.crv == 1)       // ES256 + P-256 (NIST)
         && ! (ret.alg == -8 && ret.crv == 6 )) {   // EdDSA + Ed25519
            throw new Error(`Unknown alg: ${ret.alg}, crv: ${ret.crv}`);
        }

        return ret;
    }

    throw new Error(`Unsupported kty: ${kty}`)
}

interface AttestedCredentialData {
    aaguid: Uint8Array|undefined;
    credentialId: Uint8Array|undefined;
    credentialPublicKey: COSEPublicKey|undefined;
}

interface AuthenticatorData {
    rpIdHash: Uint8Array;
    flags: {
        up: boolean;
        uv: boolean;
        at: boolean;
        ed: boolean;
    };
    signCount: number;
    at?: AttestedCredentialData;
}

interface AttestationObject {
    authData:Uint8Array,
    attStmt:any[],
    fmt:"packed"|"tpm"|"android-key"|"nadroid-safetynet"|"fido-u2f"|"apple"|"none"
}

export function decodeAuthenticatorData (ad: Uint8Array) {
    if( (ad.byteLength - ad.byteOffset) < 37 ) {
        throw new Error('Attestation Object must be at least 37 bytes or longer');
    }

    // https://www.w3.org/TR/webauthn-2/#sctn-authenticator-data
    const flags = ad.slice(32, 33)[0];

    const authDataDict:AuthenticatorData = {
        rpIdHash: ad.slice(0, 32),          // 32 bytes, SHA256(rp.id), e.g. SHA256(b'localhost')
        flags: {                            //  1 byte
            up: (flags & (1<<0)) != 0,      // Bit 0: User Present (UP) result
                                            // Bit 1: Reserved for future use (RFU1)
            uv: (flags & (1<<2)) != 0,      // Bit 2: User Verified (UV) result
                                            // Bits 3-5: Reserved for future use (RFU2)
            at: (flags & (1<<6)) != 0,      // Bit 6: Attested credential data included (AT)
            ed: (flags & (1<<7)) != 0       // Bit 7: Extension data included (ED).
        },
        signCount: toU32(ad.slice(33, 37))  //  4 bytes
    }

    if( authDataDict.flags.ed ) {
        throw new Error('Extension Data not supported!');
    }

    // https://www.w3.org/TR/webauthn-2/#sctn-attested-credential-data
    if( authDataDict.flags.at )
    {
        const credentialIdLength = toU16(ad.slice(53, 55));         // 2 bytes
        authDataDict.at = {
            aaguid: ad.slice(37, 53),                  // 16 bytes
            credentialId: ad.slice(55, 55+credentialIdLength),
            // vanillacbor.decodeOnlyFirst(buffer).byteLength;
            // https://www.w3.org/TR/webauthn-2/#sctn-encoded-credPubKey-examples
            credentialPublicKey: COSEPublicKey_decode(ad.slice(55+credentialIdLength).buffer)
        }
    }

    return authDataDict;
}

/**
 * Decodes an attestation object into its components
 */
function decodeAttestationObject (aob:ArrayBufferLike)
{
    // https://www.w3.org/TR/webauthn-2/#attestation-object
    const attestationObject = CBOR.decode<AttestationObject>(new Uint8Array(aob).buffer);

    // For details of `attStmt` see:
    // - https://www.w3.org/TR/webauthn/#sctn-defined-attestation-formats
    // - https://www.iana.org/assignments/webauthn/webauthn.xhtml#webauthn-attestation-statement-format-ids

    const ad = attestationObject.authData;

    return decodeAuthenticatorData(ad);
}

export async function credentialCreate (rp: PublicKeyCredentialRpEntity, user:PublicKeyCredentialUserEntity, challenge:Uint8Array)
{
    let pkc = await navigator.credentials.create({
        publicKey: {
            attestation: "none",
            challenge: challenge.buffer,
            pubKeyCredParams: [
                {alg: -8, type: "public-key"},   // Ed25519
                {alg: -7, type: "public-key"},   // ES256
                {alg: -257, type: "public-key"}  // RS256
            ],
            rp,
            user
        }
    }) as PublicKeyCredential|null;

    if( ! pkc ) {
        throw new Error('No PublicKeyCredential returned!');
    }

    const resp = pkc.response as AuthenticatorAttestationResponse;
    console.log(pkc);
    return {
        id: new Uint8Array(pkc.rawId),
        cd: new TextDecoder('utf-8').decode(resp.clientDataJSON),
        ad: decodeAttestationObject(resp.attestationObject)
    };
}

var asn1_sig_schema = new asn1js.Sequence({
    name: "sig",
    value: [
      new asn1js.Integer({
        name: "r"
      }),
      new asn1js.Integer({
        name: "s"
      })
    ]
  });


export async function credentialGet(credentials:Uint8Array[])
{
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const authed = await navigator.credentials.get({
        publicKey: {
            allowCredentials: credentials.map((_) => { return {id: _, type: 'public-key'} as PublicKeyCredentialDescriptor; }),
            challenge,
        }
    }) as PublicKeyCredential;

    const resp = authed.response as AuthenticatorAssertionResponse;

    const blah = asn1js.verifySchema(resp.signature, asn1_sig_schema);
    if( ! blah.verified ) {
        throw new Error("Unable to decode ASN.1 signature!");
    }

    const result: {r:asn1js.Integer, s:asn1js.Integer} = blah.result as any;
    const r = result.r.toBigInt();
    const s = result.s.toBigInt();
    return {
        in_credentialIdHashed: utils.arrayify(utils.keccak256(new Uint8Array(authed.rawId))),
        in_authenticatorData: new Uint8Array(resp.authenticatorData),
        in_clientDataJSON: new Uint8Array(resp.clientDataJSON),
        in_sigR: r,
        in_sigS: s
    };
}