
export let cart;

// Attempt to retrieve and parse the cart from localStorage
const storedCart = localStorage.getItem('cart');
if (storedCart && storedCart !== 'undefined') {
  try {
    cart = JSON.parse(storedCart);
  } catch (e) {
    console.error('Error parsing cart from localStorage:', e);
    cart = []; // Initialize as an empty array on error
  }
} else {
  // Default cart if none exists in localStorage
  cart = [
    {
      productId: "e43638ce-6aa0-4b85-b27f-e1d07eb678c6",
      quantity: 2,
    },
    {
      productId: "f8b7f3e3-3b0e-4e3d-8e4c-6f8f1d0f2f6d",
      quantity: 4,
    },
  ];
}

function saveToStorage (){
  localStorage.setItem('cart', JSON.stringify(cart));
}


export function addToCart(productId) {
  const quantitySelector = document.querySelector(`.js-quantity-selector-${productId}`).value;
  const quantity = Number(quantitySelector);
  const addedMessage = document.querySelector(`.js-added-to-cart-${productId}`);
  addedMessage.classList.add('added-to-cart-visible');
  const addedMessageTimeouts = {};


  const previousTimeoutId = addedMessageTimeouts[productId];
      if (previousTimeoutId) {
        clearTimeout(previousTimeoutId);
      }

  const timeoutId = setTimeout(() => {
    addedMessage.classList.remove('added-to-cart-visible');
  }, 2000);

  addedMessageTimeouts[productId] = timeoutId;


  let matchingItem;

  cart.forEach((cartItem) => {
    if (productId === cartItem.productId) {
      matchingItem = cartItem;
    }
  })

  if(matchingItem) {
    matchingItem.quantity += 1;
  } else {
    cart.push({
      productId,
      quantity,
    });
  };

  saveToStorage()
}


export function deleteCartItem(productId){
  const newCart = [];
  cart.forEach((cartItem) => {
    if (cartItem.productId !== productId) {
      newCart.push(cartItem);
    }
  });

  cart = newCart;

  saveToStorage()
}


export function calculateCartQuantity(){
  let cardQuantity = 0;

  cart.forEach((cartItem) => {
    cardQuantity += cartItem.quantity;
  })

  return cardQuantity
}

export function updateQuantity(productId, newQuantity) {
  let matchingItem;

  cart.forEach((cartItem) => {
    if(productId === cartItem.productId) {
      matchingItem = cartItem;
    }

    matchingItem.quantity = newQuantity;
  })
}
