// Trusted hint clicks use the same CSS coordinates as terminal pointer input.
export async function dispatchClick(client, x, y) {
  const common = { x, y, button: 'left', clickCount: 1 };
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common, buttons: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common, buttons: 0 });
}
