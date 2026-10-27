'use client';
import { useEffect, useState, type FormEvent } from 'react';
export default function ActivationForm(){
 const [qr,setQr]=useState('');const [token,setToken]=useState('');const [email,setEmail]=useState('');const [studentId,setStudentId]=useState('');const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);
 useEffect(()=>{const p=new URLSearchParams(window.location.hash.slice(1));setQr(p.get('qr')??'');setToken(p.get('email')??'');window.history.replaceState(null,'',window.location.pathname);},[]);
 async function submit(event:FormEvent){event.preventDefault();setBusy(true);try{const response=await fetch('/api/v1/activation/'+(token?'redeem':'email'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(token?{token,studentId}:{qrToken:qr,email})});const body=await response.json();setMessage(response.ok?(token?'Account activated. Sign in with your verified Gitea account.':'Check your university email for the activation link.'):body.error?.message??'Activation failed');}catch{setMessage('Activation service unavailable');}finally{setBusy(false);}}
 if(!qr&&!token)return <p>Open the QR invitation supplied by your teacher or the link in your university email.</p>;
 return <form onSubmit={submit}>{token?<label>Student ID <input required value={studentId} onChange={e=>setStudentId(e.target.value)} autoComplete="off" /></label>:<label>University email <input required type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" /></label>}<button disabled={busy} type="submit">{token?'Activate account':'Send verification email'}</button><p role="status">{message}</p>{message.startsWith('Account activated')&&<a href="/api/auth/oidc/start">Sign in</a>}</form>;
}
